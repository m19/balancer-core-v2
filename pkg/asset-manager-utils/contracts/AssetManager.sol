// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import "@balancer-labs/v2-vault/contracts/interfaces/IVault.sol";

import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/IERC20.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";

import "./IAssetManager.sol";

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

// solhint-disable no-empty-blocks
// solhint-disable var-name-mixedcase
// solhint-disable private-vars-leading-underscore
abstract contract AssetManager is IAssetManager {
    using Math for uint256;
    using Math for uint64;

    /// @notice The Balancer Vault contract
    IVault public immutable vault; // TODO: make this a constant?

    /// @notice The token which this asset manager is investing
    IERC20 public immutable token;

    /// @notice the total number of shares with claims on the asset manager's AUM
    uint256 public totalSupply;

    // mapping from poolIds to the number of owned shares
    mapping(bytes32 => uint256) private _balances;

    uint64 private constant ONE = 1e18;

    // mapping from poolIds to the fraction of that pool's assets which may be invested
    mapping(bytes32 => PoolConfig) private _poolConfig;

    constructor(IVault _vault, address _token) {
        IERC20(_token).approve(address(_vault), type(uint256).max);
        vault = _vault;
        token = IERC20(_token);
    }

    modifier onlyPoolController(bytes32 poolId) {
        address poolAddress = address((uint256(poolId) >> (12 * 8)) & (2**(20 * 8) - 1));
        require(msg.sender == poolAddress, "Only callable by pool controller");
        _;
    }

    /**
     * @param poolId - The id of the pool of interest
     * @return The amount of the underlying tokens which are owned by the specified pool
     */
    function balanceOf(bytes32 poolId) public view returns (uint256) {
        return _poolManaged(poolId, readAUM());
    }

    /**
     * @param poolId - The id of the pool of interest
     * @return The amount of the underlying tokens which are owned by the specified pool
     */
    function _poolManaged(bytes32 poolId, uint256 aum) public view returns (uint256) {
        if (totalSupply == 0) return 0;
        return _balances[poolId].mul(aum).divDown(totalSupply);
    }

    /**
     * @param poolId - The id of the pool of interest
     * @return the number of shares owned by the specified pool
     */
    function balanceOfShares(bytes32 poolId) public view returns (uint256) {
        return _balances[poolId];
    }

    function _mint(bytes32 poolId, uint256 amount) internal {
        _balances[poolId] = _balances[poolId].add(amount);
        totalSupply = totalSupply.add(amount);
    }

    function _burn(bytes32 poolId, uint256 amount) internal {
        _balances[poolId] = _balances[poolId].sub(amount);
        totalSupply = totalSupply.sub(amount);
    }

    // Investment configuration

    function getPoolConfig(bytes32 poolId) external view returns (PoolConfig memory) {
        return _poolConfig[poolId];
    }

    //function setInvestablePercent(bytes32 poolId, uint256 investmentPercent) external onlyPoolController(poolId) {
    function setPoolConfig(bytes32 poolId, PoolConfig calldata config) external override {
        require(config.upperCriticalPercentage <= ONE, "Upper critical level must be less than 100%");
        require(
            config.targetPercentage <= config.upperCriticalPercentage,
            "Target must be less than upper critical level"
        );
        require(
            config.lowerCriticalPercentage <= config.targetPercentage,
            "Lower critical level must be less than target"
        );
        require(config.feePercentage <= ONE / 10, "Fee on critical rebalances must be less than 10%");

        _poolConfig[poolId] = config;
    }

    function _getTargetInvestment(
        uint256 cash,
        uint256 managed,
        uint256 investablePercent
    ) private pure returns (uint256) {
        return (cash + managed).mul(investablePercent).divDown(ONE);
    }

    function getPoolBalances(bytes32 poolId) public view returns (uint256 poolCash, uint256 poolManaged) {
        return _getPoolBalances(poolId, readAUM());
    }

    function _getPoolBalances(bytes32 poolId, uint256 aum)
        internal
        view
        returns (uint256 poolCash, uint256 poolManaged)
    {
        (poolCash, , , ) = vault.getPoolTokenInfo(poolId, token);
        // Calculate the managed portion of funds locally as the Vault is unaware of returns
        poolManaged = totalSupply > 0 ? _balances[poolId].mul(aum).divDown(totalSupply) : 0;
    }

    /**
     * @return The difference in token between the target investment
     * and the currently invested amount (i.e. the amount that can be invested)
     */
    function maxInvestableBalance(bytes32 poolId) public view returns (int256) {
        (uint256 poolCash, uint256 poolManaged) = _getPoolBalances(poolId, readAUM());
        return
            int256((poolCash + poolManaged).mul(_poolConfig[poolId].targetPercentage).divDown(ONE)) -
            int256(poolManaged);
    }

    /**
     * @return the target investment percent for the pool
     */
    function getRebalanceFee(bytes32 poolId) external view returns (uint256) {
        (uint256 poolCash, uint256 poolManaged) = _getPoolBalances(poolId, readAUM());
        PoolConfig memory config = _poolConfig[poolId];
        return _getRebalanceFee(poolCash, poolManaged, config);
    }

    /**
     * @return the target investment percent for the pool
     */
    function _getRebalanceFee(
        uint256 poolCash,
        uint256 poolManaged,
        PoolConfig memory config
    ) internal pure returns (uint256) {
        uint256 upperCriticalManagedBalance = (poolCash + poolManaged).mul(config.upperCriticalPercentage).divDown(ONE);
        if (poolManaged > upperCriticalManagedBalance) {
            return poolManaged.sub(upperCriticalManagedBalance).mul(config.feePercentage).divDown(ONE);
        }
        uint256 lowerCriticalManagedBalance = (poolCash + poolManaged).mul(config.lowerCriticalPercentage).divDown(ONE);
        if (poolManaged < lowerCriticalManagedBalance) {
            return lowerCriticalManagedBalance.sub(poolManaged).mul(config.feePercentage).divDown(ONE);
        }
        return 0;
    }

    // Reporting

    /**
     * @notice Updates the Vault on the value of the pool's investment returns
     * @param poolId - the id of the pool for which to update the balance
     */
    function updateBalanceOfPool(bytes32 poolId) public {
        IVault.PoolBalanceOp[] memory ops = new IVault.PoolBalanceOp[](1);
        ops[0] = IVault.PoolBalanceOp(IVault.PoolBalanceOpKind.UPDATE, poolId, token, balanceOf(poolId));

        vault.managePoolBalance(ops);
    }

    // Deposit / Withdraw

    /**
     * @dev When withdrawing `amount` will be moved from the pool's cash to managed balance
     * As these funds are to be paid as fees (and so lost) we cache the previous managed balance and restore it.
     */
    function _removeFeesFromVault(bytes32 poolId, uint256 amount) private {
        (, uint256 poolManaged, , ) = vault.getPoolTokenInfo(poolId, token);

        // Pull funds from the vault and update managed balance with original value
        IVault.PoolBalanceOp[] memory ops = new IVault.PoolBalanceOp[](2);
        ops[0] = IVault.PoolBalanceOp(IVault.PoolBalanceOpKind.WITHDRAW, poolId, token, amount);
        ops[1] = IVault.PoolBalanceOp(IVault.PoolBalanceOpKind.UPDATE, poolId, token, poolManaged);

        vault.managePoolBalance(ops);
    }

    /**
     * @notice Rebalances funds between pool and asset manager to maintain target investment percentage.
     * If the pool is below it's critical threshold for the amount invested then calling this will send a small reward
     */
    function rebalance(bytes32 poolId) external {
        uint256 rebalancerFee = _rebalance(poolId);

        if (rebalancerFee > 0) {
            _removeFeesFromVault(poolId, rebalancerFee);

            // Send fee to rebalancer
            token.transfer(msg.sender, rebalancerFee);
        }
    }

    struct BatchSwap {
        IVault.BatchSwapStep[] swaps;
        IAsset[] assets;
        IVault.FundManagement funds;
        int256[] limits;
        uint256 deadline;
    }

    /**
     * @notice Rebalances funds between pool and asset manager to maintain target investment percentage.
     * Any reward from rebalancing the pool is immediately used in the provided batch swap.
     */
    function rebalanceAndSwap(bytes32 poolId, BatchSwap memory swap) external {
        uint256 rebalancerFee = _rebalance(poolId);

        if (rebalancerFee > 0) {
            _removeFeesFromVault(poolId, rebalancerFee);

            // Ensure that we use the full fee as input to the swap
            swap.swaps[0].amount = rebalancerFee;
            require(swap.funds.sender == address(this), "Asset Manager must be sender");
            require(!swap.funds.fromInternalBalance, "Can't use Asset Manager's internal balance");
            require(
                address(swap.assets[swap.swaps[0].assetInIndex]) == address(token),
                "Must swap asset manager's token"
            );
            vault.batchSwap(IVault.SwapKind.GIVEN_IN, swap.swaps, swap.assets, swap.funds, swap.limits, swap.deadline);
        }
    }

    /**
     * @notice Rebalances funds between pool and asset manager to maintain target investment percentage.
     * @return feeAmount - the amount of tokens to be made available to msg.sender as a fee
     */
    function _rebalance(bytes32 poolId) internal returns (uint256 feeAmount) {
        uint256 aum = readAUM();
        (uint256 poolCash, uint256 poolManaged) = _getPoolBalances(poolId, aum);
        PoolConfig memory config = _poolConfig[poolId];

        uint256 targetInvestment = (poolCash + poolManaged).mul(config.targetPercentage).divDown(ONE);
        if (targetInvestment > poolManaged) {
            // Pool is under-invested so add more funds
            uint256 rebalanceAmount = targetInvestment.sub(poolManaged);

            // If pool is above critical threshold then we want to pay a fee to rebalancer
            // The fee is paid on the portion of managed funds which are above the critical threshold
            feeAmount = _getRebalanceFee(poolCash, poolManaged, config);

            // As paying out fees reduces the TVL of the pool, we must correct the amount invested to account for this
            capitalIn(poolId, rebalanceAmount.sub(feeAmount.mul(config.targetPercentage).divDown(ONE)));
        } else {
            // Pool is over-invested so remove some funds
            uint256 rebalanceAmount = poolManaged.sub(targetInvestment);

            // If pool is below critical threshold then we want to pay a fee to rebalancer
            // The fee is paid on the portion of managed funds which are below the critical threshold
            feeAmount = _getRebalanceFee(poolCash, poolManaged, config);

            capitalOut(poolId, rebalanceAmount.sub(feeAmount.mul(config.targetPercentage).divDown(ONE)));
        }
    }

    /**
     * @dev Transfers capital into the asset manager, and then invests it
     * @param poolId - the id of the pool depositing funds into this asset manager
     * @param amount - the amount of tokens being deposited
     */
    function capitalIn(bytes32 poolId, uint256 amount) public {
        uint256 aum = readAUM();
        (uint256 poolCash, uint256 poolManaged) = _getPoolBalances(poolId, aum);
        uint256 targetInvestment = (poolCash + poolManaged).mul(_poolConfig[poolId].targetPercentage).divDown(ONE);

        require(targetInvestment >= poolManaged.add(amount), "investment amount exceeds target");

        IVault.PoolBalanceOp[] memory ops = new IVault.PoolBalanceOp[](2);
        // Update the vault with new managed balance accounting for returns
        ops[0] = IVault.PoolBalanceOp(IVault.PoolBalanceOpKind.UPDATE, poolId, token, poolManaged);
        // Pull funds from the vault
        ops[1] = IVault.PoolBalanceOp(IVault.PoolBalanceOpKind.WITHDRAW, poolId, token, amount);

        vault.managePoolBalance(ops);

        uint256 mintAmount = _invest(poolId, amount, aum);

        // mint pool share of the asset manager
        _mint(poolId, mintAmount);
    }

    /**
     * @notice Divests capital back to the asset manager and then sends it to the vault
     * @param poolId - the id of the pool withdrawing funds from this asset manager
     * @param amount - the amount of tokens to withdraw to the vault
     */
    function capitalOut(bytes32 poolId, uint256 amount) public {
        uint256 aum = readAUM();
        uint256 sharesToBurn = totalSupply.mul(amount).divUp(aum);
        _redeemShares(poolId, sharesToBurn, aum);
    }

    /**
     * @notice Divests capital back to the asset manager and then sends it to the vault
     * @param poolId - the id of the pool withdrawing funds from this asset manager
     * @param shares - the amount of shares being burned
     */
    function redeemShares(bytes32 poolId, uint256 shares) public {
        _redeemShares(poolId, shares, readAUM());
    }

    /**
     * @notice Divests capital back to the asset manager and then sends it to the vault
     * @param poolId - the id of the pool withdrawing funds from this asset manager
     * @param shares - the amount of shares being burned
     */
    function _redeemShares(
        bytes32 poolId,
        uint256 shares,
        uint256 aum
    ) private {
        uint256 tokensOut = _divest(poolId, shares, aum);
        (uint256 poolCash, uint256 poolManaged) = _getPoolBalances(poolId, aum);
        uint256 targetInvestment = (poolCash + poolManaged).mul(_poolConfig[poolId].targetPercentage).divDown(ONE);

        require(poolManaged >= targetInvestment.add(tokensOut), "withdrawal leaves insufficient balance invested");

        _burn(poolId, shares);

        // As we have now burned the pool's shares calling _poolManaged(poolId)
        // will now return the pool's managed balance post-withdrawal

        // Update with gains and remove withdrawn tokens from AUM
        IVault.PoolBalanceOp[] memory ops = new IVault.PoolBalanceOp[](2);
        // Send funds back to the vault
        ops[0] = IVault.PoolBalanceOp(IVault.PoolBalanceOpKind.DEPOSIT, poolId, token, tokensOut);
        // Update the vault with new managed balance accounting for returns
        ops[1] = IVault.PoolBalanceOp(
            IVault.PoolBalanceOpKind.UPDATE,
            poolId,
            token,
            _poolManaged(poolId, aum.sub(tokensOut))
        );

        vault.managePoolBalance(ops);
    }

    /**
     * @dev Invests capital inside the asset manager
     * @param poolId - the id of the pool depositing funds into this asset manager
     * @param amount - the amount of tokens being deposited
     * @return the number of shares to mint for the pool
     */
    function _invest(
        bytes32 poolId,
        uint256 amount,
        uint256 aum
    ) internal virtual returns (uint256);

    /**
     * @dev Divests capital back to the asset manager
     * @param poolId - the id of the pool withdrawing funds from this asset manager
     * @param shares - the amount of shares being burned
     * @return the number of tokens to return to the vault
     */
    function _divest(
        bytes32 poolId,
        uint256 shares,
        uint256 aum
    ) internal virtual returns (uint256);

    /**
     * @return the current assets under management of this asset manager
     */
    function readAUM() public view virtual returns (uint256);
}
