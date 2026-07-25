// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcDailyStreak} from "../src/ArcDailyStreak.sol";

/// @notice Deploys ArcDailyStreak to Arc Testnet.
/// @dev Required environment variables:
///      - PRIVATE_KEY  deployer key (use a throwaway key; testnet only)
///      - OWNER        admin address (recommend a Safe or hardware wallet)
///      - TREASURY     fee destination (recommend a Safe multisig)
///      USDC is pinned to the canonical Arc Testnet native USDC and is not
///      configurable via env on purpose: pointing at any other token is the
///      single most dangerous deploy mistake possible for this contract.
///
///      forge script script/Deploy.s.sol:Deploy \
///        --rpc-url https://rpc.testnet.arc.network --broadcast
contract Deploy is Script {
    /// @dev Canonical Arc Testnet native USDC (6 decimals). Verified live.
    address public constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;

    /// @dev Arc Testnet chain id (decimal 5042002 / hex 0x4cef52).
    uint256 public constant ARC_TESTNET_CHAIN_ID = 5042002;

    function run() external returns (ArcDailyStreak deployed) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Deploy: wrong chain (expect Arc Testnet 5042002)");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER");
        address treasury = vm.envAddress("TREASURY");

        require(owner != address(0), "Deploy: OWNER is zero");
        require(treasury != address(0), "Deploy: TREASURY is zero");

        vm.startBroadcast(pk);
        deployed = new ArcDailyStreak(ARC_TESTNET_USDC, owner, treasury);
        vm.stopBroadcast();

        console2.log("ArcDailyStreak deployed:", address(deployed));
        console2.log("  USDC     :", ARC_TESTNET_USDC);
        console2.log("  Owner    :", owner);
        console2.log("  Treasury :", treasury);
    }
}
