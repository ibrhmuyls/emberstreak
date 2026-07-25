// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 6-decimal mock of Arc Testnet USDC for local testing only.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev 18-decimal token: must be rejected by the constructor.
contract Mock18Decimals is ERC20 {
    constructor() ERC20("Wrong", "WRONG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Fee-on-transfer token (6 decimals): transferFrom delivers less than
///      requested. The contract must revert with TransferFailed.
contract FeeOnTransferUSDC is ERC20 {
    constructor() ERC20("Fee USDC", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100; // 1% burn
        _spendAllowance(from, msg.sender, amount);
        _burn(from, fee);
        _transfer(from, to, amount - fee);
        return true;
    }
}

interface IStreakLike {
    function register() external;
    function claim() external;
}

/// @dev ERC20 whose transferFrom re-enters the streak contract, to prove the
///      nonReentrant guard + CEI hold even with a malicious token.
contract ReentrantToken is ERC20 {
    IStreakLike public target;
    bool public attackOnClaim;
    bool private _attacking;

    constructor() ERC20("Evil", "EVIL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(IStreakLike t, bool onClaim) external {
        target = t;
        attackOnClaim = onClaim;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (address(target) != address(0) && !_attacking) {
            _attacking = true;
            if (attackOnClaim) target.claim();
            else target.register();
            _attacking = false;
        }
        return super.transferFrom(from, to, amount);
    }
}
