// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcDailyStreak} from "../src/ArcDailyStreak.sol";
import {MockUSDC} from "./mocks/Mocks.sol";

/// @dev Bounded random actor that registers, claims, warps time, and performs
///      owner operations against the streak contract. Ghost variables track
///      expectations that the invariants assert against real state.
contract StreakHandler is Test {
    ArcDailyStreak public streak;
    MockUSDC public usdc;
    address public owner;
    address public treasury;

    address[] public actors;
    mapping(address actor => uint32 longest) public ghostLongest;
    uint256 public ghostCollected;
    uint256 public ghostWithdrawn;

    constructor(ArcDailyStreak _streak, MockUSDC _usdc, address _owner, address _treasury) {
        streak = _streak;
        usdc = _usdc;
        owner = _owner;
        treasury = _treasury;
        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(0xA11CE0 + i));
            actors.push(a);
            usdc.mint(a, 1_000_000 * 1e6);
            vm.prank(a);
            usdc.approve(address(streak), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1 hours, 72 hours);
        vm.warp(block.timestamp + secs);
    }

    function register(uint256 actorSeed) external {
        address a = actors[bound(actorSeed, 0, actors.length - 1)];
        if (streak.getUser(a).exists || streak.paused()) return;
        vm.prank(a);
        streak.register();
        ghostCollected += streak.REGISTRATION_FEE();
        ghostLongest[a] = 1;
    }

    function claim(uint256 actorSeed) external {
        address a = actors[bound(actorSeed, 0, actors.length - 1)];
        if (!streak.canClaim(a)) return;
        vm.prank(a);
        streak.claim();
        ghostCollected += streak.DAILY_FEE();
        uint32 longest = streak.longestStreak(a);
        if (longest > ghostLongest[a]) ghostLongest[a] = longest;
    }

    function withdraw(uint256 amount) external {
        uint256 bal = usdc.balanceOf(address(streak));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(owner);
        streak.withdraw(amount);
        ghostWithdrawn += amount;
    }

    function pauseToggle(bool p) external {
        vm.startPrank(owner);
        if (p && !streak.paused()) streak.pause();
        else if (!p && streak.paused()) streak.unpause();
        vm.stopPrank();
    }

    function setTreasury(uint256 seed) external {
        // rotate among two known-good treasuries
        address t = seed % 2 == 0 ? treasury : address(uint160(0x7E57));
        vm.prank(owner);
        streak.setTreasury(t);
    }
}

contract ArcDailyStreakInvariantTest is Test {
    ArcDailyStreak internal streak;
    MockUSDC internal usdc;
    StreakHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_753_400_000);
        usdc = new MockUSDC();
        streak = new ArcDailyStreak(address(usdc), owner, treasury);
        handler = new StreakHandler(streak, usdc, owner, treasury);
        targetContract(address(handler));
    }

    /// @dev Economic parameters can never change.
    function invariant_ImmutableParameters() public view {
        assertEq(streak.registrationFee(), 1_000_000);
        assertEq(streak.dailyFee(), 10_000);
        assertEq(address(streak.USDC()), address(usdc));
        assertEq(streak.CLAIM_INTERVAL(), 24 hours);
        assertEq(streak.STREAK_WINDOW(), 48 hours);
    }

    /// @dev Contract balance always equals collected minus withdrawn
    ///      (no other flow exists in this system).
    function invariant_BalanceAccounting() public view {
        assertEq(
            usdc.balanceOf(address(streak)),
            streak.totalCollected() - streak.totalWithdrawn(),
            "balance == collected - withdrawn"
        );
        assertEq(streak.totalCollected(), handler.ghostCollected());
        assertEq(streak.totalWithdrawn(), handler.ghostWithdrawn());
    }

    /// @dev Longest streak is monotone non-decreasing and >= current streak
    ///      for every actor; timestamps are internally consistent.
    function invariant_UserRecordIntegrity() public view {
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actors(i);
            ArcDailyStreak.User memory u = streak.getUser(a);
            if (!u.exists) {
                assertEq(u.streak, 0);
                assertEq(u.longestStreak, 0);
                assertEq(u.registeredAt, 0);
                assertEq(u.lastClaim, 0);
                continue;
            }
            assertGe(u.longestStreak, u.streak, "longest >= current");
            assertGe(u.longestStreak, handler.ghostLongest(a), "longest never decreased");
            assertGe(u.lastClaim, u.registeredAt, "lastClaim >= registeredAt");
            assertGe(u.streak, 1, "registered user streak >= 1");
        }
    }

    /// @dev Only the treasury (never the owner) ever receives protocol funds.
    function invariant_OwnerNeverPaid() public view {
        assertEq(usdc.balanceOf(owner), 0, "owner must never receive USDC");
    }
}
