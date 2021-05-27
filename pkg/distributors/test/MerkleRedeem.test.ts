import { ethers } from 'hardhat';
import { BytesLike, BigNumber } from 'ethers';
import { expect } from 'chai';
import { Contract } from 'ethers';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { expectBalanceChange } from '@balancer-labs/v2-helpers/src/test/tokenBalance';
import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';

import { bn } from '@balancer-labs/v2-helpers/src/numbers';
import { MerkleTree } from '../lib/merkleTree';

import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

function encodeElement(address: string, balance: BigNumber): string {
  return ethers.utils.solidityKeccak256(['address', 'uint'], [address, balance]);
}

describe('MerkleRedeem', () => {
  let rewardTokens: TokenList, rewardToken: Token, vault: Contract, merkleRedeem: Contract;

  let admin: SignerWithAddress, lp1: SignerWithAddress, lp2: SignerWithAddress, other: SignerWithAddress;
  const rewardTokenInitialBalance = bn(100e18);

  before('setup', async () => {
    [, admin, lp1, lp2, other] = await ethers.getSigners();
  });

  sharedBeforeEach('deploy vault and tokens', async () => {
    const vaultHelper = await Vault.create({ admin });
    vault = vaultHelper.instance;

    rewardTokens = await TokenList.create(['DAI'], { sorted: true });
    rewardToken = rewardTokens.DAI;

    merkleRedeem = await deploy('MerkleRedeem', {
      args: [vault.address, rewardToken.address],
      from: admin,
    });
    await rewardTokens.mint({ to: admin.address, amount: rewardTokenInitialBalance });
    await rewardTokens.approve({ to: merkleRedeem.address, from: [admin] });
  });

  it('stores an allocation', async () => {
    const claimBalance = bn('9876');

    const elements = [encodeElement(lp1.address, claimBalance)];
    const merkleTree = new MerkleTree(elements);
    const root = merkleTree.getHexRoot();

    await merkleRedeem.connect(admin).seedAllocations(bn(1), root, claimBalance);

    const proof = merkleTree.getHexProof(elements[0]);

    const result = await merkleRedeem.verifyClaim(lp1.address, 1, claimBalance, proof);
    expect(result).to.equal(true);
  });

  it('Emits RewardAdded when an allocation is stored', async () => {
    const claimBalance = bn('9876');

    const elements = [encodeElement(lp1.address, claimBalance)];
    const merkleTree = new MerkleTree(elements);
    const root = merkleTree.getHexRoot();

    const receipt = await (await merkleRedeem.connect(admin).seedAllocations(bn(1), root, claimBalance)).wait();

    expectEvent.inReceipt(receipt, 'RewardAdded', {
      token: rewardToken.address,
      amount: claimBalance,
    });
  });

  it('stores multiple allocations', async () => {
    const claimBalance0 = bn('1000');
    const claimBalance1 = bn('2000');

    const elements = [encodeElement(lp1.address, claimBalance0), encodeElement(lp2.address, claimBalance1)];
    const merkleTree = new MerkleTree(elements);
    const root = merkleTree.getHexRoot();

    await merkleRedeem.connect(admin).seedAllocations(1, root, bn('3000'));

    const proof0 = merkleTree.getHexProof(elements[0]);
    let result = await merkleRedeem.verifyClaim(lp1.address, 1, claimBalance0, proof0);
    expect(result).to.equal(true); //"account 0 should have an allocation";

    const proof1 = merkleTree.getHexProof(elements[1]);
    result = await merkleRedeem.verifyClaim(lp2.address, 1, claimBalance1, proof1);
    expect(result).to.equal(true); // "account 1 should have an allocation";
  });

  describe('With an allocation', () => {
    const claimableBalance = bn('1000');
    let elements: string[];
    let merkleTree: MerkleTree;

    beforeEach(async () => {
      elements = [encodeElement(lp1.address, claimableBalance)];
      merkleTree = new MerkleTree(elements);
      const root = merkleTree.getHexRoot();

      await merkleRedeem.connect(admin).seedAllocations(1, root, claimableBalance);
    });

    it('Allows the user to claimWeek', async () => {
      const merkleProof: BytesLike[] = merkleTree.getHexProof(elements[0]);

      await expectBalanceChange(
        () => merkleRedeem.connect(lp1).claimWeek(lp1.address, 1, claimableBalance, merkleProof, false),
        rewardTokens,
        [{ account: lp1, changes: { DAI: claimableBalance } }]
      );
    });

    it('Emits RewardPaid when an allocation is claimed', async () => {
      const merkleProof: BytesLike[] = merkleTree.getHexProof(elements[0]);

      const receipt = await (
        await merkleRedeem.connect(lp1).claimWeek(lp1.address, 1, claimableBalance, merkleProof, false)
      ).wait();

      expectEvent.inReceipt(receipt, 'RewardPaid', {
        user: lp1.address,
        rewardToken: rewardToken.address,
        amount: claimableBalance,
      });
    });

    it('Marks claimed weeks as claimed', async () => {
      const merkleProof: BytesLike[] = merkleTree.getHexProof(elements[0]);
      await merkleRedeem.connect(lp1).claimWeek(lp1.address, 1, claimableBalance, merkleProof, false);

      const isClaimed = await merkleRedeem.claimed(1, lp1.address);
      expect(isClaimed).to.equal(true); // "claim should be marked as claimed";
    });

    it('Allows the user to claimWeek to internal balance', async () => {
      const merkleProof: BytesLike[] = merkleTree.getHexProof(elements[0]);

      await expectBalanceChange(
        () => merkleRedeem.connect(lp1).claimWeek(lp1.address, 1, claimableBalance, merkleProof, true),
        rewardTokens,
        [{ account: lp1, changes: { DAI: claimableBalance } }],
        vault
      );

      const isClaimed = await merkleRedeem.claimed(1, lp1.address);
      expect(isClaimed).to.equal(true); // "claim should be marked as claimed";
    });

    it('Reverts when a user attempts to claim for another user', async () => {
      const merkleProof = merkleTree.getHexProof(elements[0]);

      const errorMsg = 'Incorrect merkle proof';
      expect(
        merkleRedeem.connect(other).claimWeek(lp1.address, 1, claimableBalance, merkleProof, false)
      ).to.be.revertedWith(errorMsg);
    });

    it('Reverts when the user attempts to claim the wrong balance', async () => {
      const incorrectClaimedBalance = bn('666');
      const merkleProof = merkleTree.getHexProof(elements[0]);
      const errorMsg = 'Incorrect merkle proof';
      expect(
        merkleRedeem.connect(lp1).claimWeek(lp1.address, 1, incorrectClaimedBalance, merkleProof, false)
      ).to.be.revertedWith(errorMsg);
    });

    it('Reverts when the user attempts to claim twice', async () => {
      const merkleProof = merkleTree.getHexProof(elements[0]);

      await merkleRedeem.connect(lp1).claimWeek(lp1.address, 1, claimableBalance, merkleProof, false);

      const errorMsg = 'cannot claim twice';
      expect(
        merkleRedeem.connect(lp1).claimWeek(lp1.address, 1, claimableBalance, merkleProof, false)
      ).to.be.revertedWith(errorMsg);
    });

    it('Reverts when an admin attempts to overwrite an allocationn', async () => {
      const elements2 = [encodeElement(lp1.address, claimableBalance), encodeElement(lp2.address, claimableBalance)];
      const merkleTree2 = new MerkleTree(elements2);
      const root2 = merkleTree2.getHexRoot();

      const errorMsg = 'cannot rewrite merkle root';
      expect(merkleRedeem.connect(admin).seedAllocations(1, root2, claimableBalance.mul(2))).to.be.revertedWith(
        errorMsg
      );
    });
  });

  describe('With several allocations', () => {
    const claimBalance1 = bn('1000');
    const claimBalance2 = bn('1234');

    let elements1: string[];
    let merkleTree1: MerkleTree;
    let root1: string;

    let elements2: string[];
    let merkleTree2: MerkleTree;
    let root2: string;

    beforeEach(async () => {
      elements1 = [encodeElement(lp1.address, claimBalance1)];
      merkleTree1 = new MerkleTree(elements1);
      root1 = merkleTree1.getHexRoot();

      elements2 = [encodeElement(lp1.address, claimBalance2)];
      merkleTree2 = new MerkleTree(elements2);
      root2 = merkleTree2.getHexRoot();

      await merkleRedeem.connect(admin).seedAllocations(bn(1), root1, claimBalance1);

      await merkleRedeem.connect(admin).seedAllocations(bn(2), root2, claimBalance2);
    });

    it('Allows the user to claim multiple weeks at once', async () => {
      const claimedBalance1 = bn('1000');
      const claimedBalance2 = bn('1234');

      const proof1: BytesLike[] = merkleTree1.getHexProof(elements1[0]);
      const proof2: BytesLike[] = merkleTree2.getHexProof(elements2[0]);

      const merkleProofs = [
        { week: bn(1), balance: claimedBalance1, merkleProof: proof1 },
        { week: bn(2), balance: claimedBalance2, merkleProof: proof2 },
      ];

      expectBalanceChange(() => merkleRedeem.connect(lp1).claimWeeks(lp1.address, merkleProofs, false), rewardTokens, [
        { account: lp1, changes: { DAI: bn('2234') } },
      ]);
    });

    it('Reports weeks as unclaimed', async () => {
      const expectedResult = [false, false];
      const result = await merkleRedeem.claimStatus(lp1.address, 1, 2);
      expect(result).to.eql(expectedResult);
    });

    it('Returns an array of merkle roots', async () => {
      const expectedResult = [root1, root2];
      const result = await merkleRedeem.merkleRoots(1, 2);
      expect(result).to.eql(expectedResult); // "claim status should be accurate"
    });

    describe('When a user has claimed one of their allocations', async () => {
      beforeEach(async () => {
        const claimedBalance1 = bn('1000');
        const proof1 = merkleTree1.getHexProof(elements1[0]);

        const merkleProofs = [{ week: bn(1), balance: claimedBalance1, merkleProof: proof1 }];

        await merkleRedeem.connect(lp1).claimWeeks(lp1.address, merkleProofs, false);
      });

      it('Reports one of the weeks as claimed', async () => {
        const expectedResult = [true, false];
        const result = await merkleRedeem.claimStatus(lp1.address, 1, 2);
        expect(result).to.eql(expectedResult);
      });
    });
  });
});
