import { ethers } from 'hardhat';
import { expect } from 'chai';
import { Contract } from 'ethers';
import { splitSignature } from '@ethersproject/bytes';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import Token from '@balancer-labs/v2-helpers/src/models/tokens/Token';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';

import { bn, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import { expectBalanceChange } from '@balancer-labs/v2-helpers/src/test/tokenBalance';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { encodeJoinWeightedPool } from '@balancer-labs/v2-helpers/src/models/pools/weighted/encoding';
import { advanceTime } from '@balancer-labs/v2-helpers/src/time';

const tokenInitialBalance = bn(200e18);
const rewardTokenInitialBalance = bn(100e18);

const setup = async () => {
  const [, admin, lp, mockAssetManager] = await ethers.getSigners();

  const tokens = await TokenList.create(['SNX', 'MKR'], { sorted: true });
  const rewardTokens = await TokenList.create(['DAI'], { sorted: true });

  // Deploy Balancer Vault
  const vaultHelper = await Vault.create({ admin });
  const vault = vaultHelper.instance;

  const pool = await deploy('v2-pool-weighted/WeightedPool', {
    args: [vault.address, 'Test Pool', 'TEST', tokens.addresses, [fp(0.5), fp(0.5)], fp(0.0001), 0, 0, admin.address],
  });

  const poolId = await pool.getPoolId();

  // Deploy staking contract for pool
  const stakingContract = await deploy('MultiRewards', {
    args: [vault.address, pool.address],
  });

  const rewardToken = rewardTokens.DAI;

  const rewardsDuration = 1; // Have a neglibile duration so that rewards are distributed instantaneously
  await stakingContract.addReward(rewardToken.address, mockAssetManager.address, rewardsDuration);

  await tokens.mint({ to: lp, amount: tokenInitialBalance });
  await tokens.approve({ to: vault.address, from: [lp] });

  await rewardTokens.mint({ to: mockAssetManager, amount: rewardTokenInitialBalance });
  await rewardTokens.approve({ to: stakingContract.address, from: [mockAssetManager] });

  const assets = tokens.addresses;

  await vault.connect(lp).joinPool(poolId, lp.address, lp.address, {
    assets,
    maxAmountsIn: Array(assets.length).fill(MAX_UINT256),
    fromInternalBalance: false,
    userData: encodeJoinWeightedPool({
      kind: 'Init',
      amountsIn: Array(assets.length).fill(tokenInitialBalance),
    }),
  });

  return {
    data: {
      poolId,
    },
    contracts: {
      tokens,
      rewardTokens,
      pool,
      stakingContract,
      vault,
    },
  };
};

describe('Staking contract', () => {
  let lp: SignerWithAddress, other: SignerWithAddress, mockAssetManager: SignerWithAddress;

  let rewardTokens: TokenList;
  let vault: Contract;
  let stakingContract: Contract;
  let rewardToken: Token;
  let pool: Contract;

  before('deploy base contracts', async () => {
    [, , lp, mockAssetManager, other] = await ethers.getSigners();
  });

  sharedBeforeEach('set up asset manager', async () => {
    const { contracts } = await setup();

    pool = contracts.pool;
    vault = contracts.vault;
    stakingContract = contracts.stakingContract;
    rewardToken = contracts.rewardTokens.DAI;
    rewardTokens = contracts.rewardTokens;
  });

  before(async () => {
    [, , lp, other] = await ethers.getSigners();
  });

  describe('stakeWithPermit', () => {
    it('successfully stakes with a permit signature', async () => {
      const bptBalance = await pool.balanceOf(lp.address);

      const { chainId } = await ethers.provider.getNetwork();
      const permitSig = await lp._signTypedData(
        {
          name: await pool.name(),
          version: '1',
          chainId,
          verifyingContract: pool.address,
        },
        {
          Permit: [
            {
              name: 'owner',
              type: 'address',
            },
            {
              name: 'spender',
              type: 'address',
            },
            {
              name: 'value',
              type: 'uint256',
            },
            {
              name: 'nonce',
              type: 'uint256',
            },
            {
              name: 'deadline',
              type: 'uint256',
            },
          ],
        },
        {
          owner: lp.address,
          spender: stakingContract.address,
          value: bptBalance,
          nonce: 0,
          deadline: MAX_UINT256,
        }
      );

      const { v, r, s } = splitSignature(permitSig);
      await stakingContract.connect(lp).stakeWithPermit(bptBalance, MAX_UINT256, v, r, s);

      const stakedBalance = await stakingContract.balanceOf(lp.address);
      expect(stakedBalance).to.be.eq(bptBalance);
    });
  });

  describe('with two stakes', () => {
    const rewardAmount = fp(1);

    beforeEach(async () => {
      const bptBalance = await pool.balanceOf(lp.address);

      await pool.connect(lp).approve(stakingContract.address, bptBalance);

      // Stake 3/4 of the bpt to the LP and 1/4 to another address
      await stakingContract.connect(lp)['stake(uint256)'](bptBalance.mul(3).div(4));
      await stakingContract.connect(lp)['stake(uint256,address)'](bptBalance.div(4), other.address);
    });

    it('sends expected amount of reward token to the rewards contract', async () => {
      await expectBalanceChange(
        () => stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, rewardAmount),
        rewardTokens,
        [{ account: stakingContract, changes: { DAI: rewardAmount } }]
      );
    });

    it('Emits RewardAdded when an allocation is stored', async () => {
      const receipt = await (
        await stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, rewardAmount)
      ).wait();

      expectEvent.inReceipt(receipt, 'RewardAdded', {
        token: rewardToken.address,
        amount: rewardAmount,
      });
    });

    it('distributes the reward according to the fraction of staked LP tokens', async () => {
      await stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, rewardAmount);
      await advanceTime(10);

      // 3/4 share
      const expectedReward = fp(0.75);
      const actualReward = await stakingContract.earned(lp.address, rewardToken.address);

      expect(expectedReward.sub(actualReward).abs()).to.be.lte(100);

      // 1/4 share
      const expectedRewardOther = fp(0.25);
      const actualRewardOther = await stakingContract.earned(other.address, rewardToken.address);

      expect(expectedRewardOther.sub(actualRewardOther).abs()).to.be.lte(100);
    });

    it('allows a user to claim the reward to an EOA', async () => {
      await stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, rewardAmount);
      await advanceTime(10);

      const expectedReward = fp(0.75);

      await expectBalanceChange(() => stakingContract.connect(lp).getReward(), rewardTokens, [
        { account: lp, changes: { DAI: ['very-near', expectedReward] } },
      ]);
    });

    it('allows a user to claim the reward to internal balance', async () => {
      await stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, rewardAmount);
      await advanceTime(10);

      const expectedReward = fp(0.75);

      await expectBalanceChange(
        () => stakingContract.connect(lp).getRewardAsInternalBalance(),
        rewardTokens,
        [{ account: lp, changes: { DAI: ['very-near', expectedReward] } }],
        vault
      );
    });

    it('Emits RewardPaid when an allocation is claimed', async () => {
      await stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, rewardAmount);
      await advanceTime(10);

      const expectedReward = bn('749999999999999923');

      const receipt = await (await stakingContract.connect(lp).getReward()).wait();

      expectEvent.inReceipt(receipt, 'RewardPaid', {
        user: lp.address,
        rewardToken: rewardToken.address,
        amount: expectedReward,
      });
    });

    describe('with a second distribution', () => {
      const secondRewardAmount = fp(2);

      beforeEach(async () => {
        await stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, rewardAmount);
        await stakingContract.connect(mockAssetManager).notifyRewardAmount(rewardToken.address, secondRewardAmount);
        // total reward = fp(3)
      });

      it('distributes the reward from both distributions', async () => {
        const expectedReward = fp(0.75).mul(3);
        await advanceTime(10);

        const actualReward = await stakingContract.earned(lp.address, rewardToken.address);
        expect(expectedReward.sub(actualReward).abs()).to.be.lte(300);
      });
    });
  });
});
