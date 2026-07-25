// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArcDailyStreak} from "../src/ArcDailyStreak.sol";
import {MockUSDC, Mock18Decimals, FeeOnTransferUSDC, ReentrantToken, IStreakLike} from "./mocks/Mocks.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract ArcDailyStreakTest is Test {
    ArcDailyStreak internal streak;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant REG_FEE = 1_000_000; // 1.00 USDC
    uint256 internal constant DAY_FEE = 10_000; // 0.01 USDC
    uint256 internal constant DAY = 24 hours;
    uint256 internal constant WINDOW = 48 hours;
    uint256 internal constant START_TS = 1_753_400_000;

    event Registered(address indexed user, uint64 timestamp, uint256 feePaid);
    event Claimed(address indexed user, uint32 streak, uint32 longestStreak, uint64 timestamp, uint256 feePaid);
    event StreakReset(address indexed user, uint32 previousStreak, uint64 timestamp);
    event Withdraw(address indexed treasury, uint256 amount);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    function setUp() public {
        vm.warp(START_TS);
        usdc = new MockUSDC();
        streak = new ArcDailyStreak(address(usdc), owner, treasury);

        _fund(alice, 1_000 * 1e6);
        _fund(bob, 1_000 * 1e6);
        _fund(carol, 1_000 * 1e6);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(streak), type(uint256).max);
    }

    function _register(address who) internal {
        vm.prank(who);
        streak.register();
    }

    // -----------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------

    function test_Constructor_SetsState() public view {
        assertEq(address(streak.USDC()), address(usdc));
        assertEq(streak.owner(), owner);
        assertEq(streak.treasury(), treasury);
        assertEq(streak.registrationFee(), REG_FEE);
        assertEq(streak.dailyFee(), DAY_FEE);
        assertEq(streak.REGISTRATION_FEE(), REG_FEE);
        assertEq(streak.DAILY_FEE(), DAY_FEE);
        assertEq(streak.CLAIM_INTERVAL(), DAY);
        assertEq(streak.STREAK_WINDOW(), WINDOW);
        assertFalse(streak.paused());
    }

    function test_Constructor_RevertZeroToken() public {
        vm.expectRevert(ArcDailyStreak.ZeroAddress.selector);
        new ArcDailyStreak(address(0), owner, treasury);
    }

    function test_Constructor_RevertZeroTreasury() public {
        vm.expectRevert(ArcDailyStreak.ZeroAddress.selector);
        new ArcDailyStreak(address(usdc), owner, address(0));
    }

    function test_Constructor_RevertZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ArcDailyStreak(address(usdc), address(0), treasury);
    }

    function test_Constructor_RevertNonContractToken() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InvalidToken.selector, eoa));
        new ArcDailyStreak(eoa, owner, treasury);
    }

    function test_Constructor_RevertWrongDecimals() public {
        Mock18Decimals wrong = new Mock18Decimals();
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InvalidToken.selector, address(wrong)));
        new ArcDailyStreak(address(wrong), owner, treasury);
    }

    // -----------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------

    function test_Register_HappyPath() public {
        uint256 balBefore = usdc.balanceOf(alice);

        vm.expectEmit(true, false, false, true);
        emit Registered(alice, uint64(START_TS), REG_FEE);
        _register(alice);

        ArcDailyStreak.User memory u = streak.getUser(alice);
        assertTrue(u.exists);
        assertEq(u.registeredAt, uint64(START_TS));
        assertEq(u.lastClaim, uint64(START_TS));
        assertEq(u.streak, 1);
        assertEq(u.longestStreak, 1);

        assertEq(usdc.balanceOf(alice), balBefore - REG_FEE);
        assertEq(usdc.balanceOf(address(streak)), REG_FEE);
        assertEq(streak.contractBalance(), REG_FEE);
        assertEq(streak.totalCollected(), REG_FEE);
        assertEq(streak.currentStreak(alice), 1);
        assertEq(streak.longestStreak(alice), 1);
        assertEq(streak.registeredAt(alice), uint64(START_TS));
        assertEq(streak.lastClaim(alice), uint64(START_TS));
    }

    function test_Register_RevertDouble() public {
        _register(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.AlreadyRegistered.selector, alice));
        _register(alice);
        // fee charged exactly once
        assertEq(usdc.balanceOf(address(streak)), REG_FEE);
    }

    function test_Register_RevertNoAllowance() public {
        address dave = makeAddr("dave");
        usdc.mint(dave, 10 * 1e6);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InsufficientAllowance.selector, REG_FEE, 0));
        streak.register();
    }

    function test_Register_RevertPartialAllowance() public {
        address dave = makeAddr("dave");
        usdc.mint(dave, 10 * 1e6);
        vm.startPrank(dave);
        usdc.approve(address(streak), REG_FEE - 1);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InsufficientAllowance.selector, REG_FEE, REG_FEE - 1));
        streak.register();
        vm.stopPrank();
    }

    function test_Register_RevertNoBalance() public {
        address broke = makeAddr("broke");
        vm.startPrank(broke);
        usdc.approve(address(streak), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InsufficientBalance.selector, REG_FEE, 0));
        streak.register();
        vm.stopPrank();
    }

    function test_Register_RevertWhenPaused() public {
        vm.prank(owner);
        streak.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        streak.register();
    }

    // -----------------------------------------------------------------
    // Claim
    // -----------------------------------------------------------------

    function test_Claim_RevertNotRegistered() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.NotRegistered.selector, alice));
        streak.claim();
    }

    function test_Claim_RevertTooEarly() public {
        _register(alice);
        vm.warp(START_TS + DAY - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.ClaimTooEarly.selector, START_TS + DAY));
        streak.claim();
    }

    function test_Claim_ExactBoundary24h() public {
        _register(alice);
        vm.warp(START_TS + DAY); // exactly 24h: allowed (>=)
        vm.prank(alice);
        streak.claim();
        assertEq(streak.currentStreak(alice), 2);
        assertEq(streak.longestStreak(alice), 2);
    }

    function test_Claim_IncrementsWithinWindow() public {
        _register(alice);
        vm.warp(START_TS + 30 hours);

        vm.expectEmit(true, false, false, true);
        emit Claimed(alice, 2, 2, uint64(START_TS + 30 hours), DAY_FEE);
        vm.prank(alice);
        streak.claim();

        assertEq(streak.currentStreak(alice), 2);
        assertEq(streak.lastClaim(alice), uint64(START_TS + 30 hours));
        assertEq(usdc.balanceOf(address(streak)), REG_FEE + DAY_FEE);
    }

    function test_Claim_ExactBoundary48h_NoReset() public {
        _register(alice);
        vm.warp(START_TS + WINDOW); // exactly 48h: NOT expired (strict >)
        vm.prank(alice);
        streak.claim();
        assertEq(streak.currentStreak(alice), 2);
    }

    function test_Claim_ResetAfter48h() public {
        _register(alice);
        // build a streak of 3
        vm.warp(START_TS + DAY);
        vm.prank(alice);
        streak.claim();
        vm.warp(START_TS + 2 * DAY);
        vm.prank(alice);
        streak.claim();
        assertEq(streak.currentStreak(alice), 3);

        // miss the window
        uint256 lateTs = START_TS + 2 * DAY + WINDOW + 1;
        vm.warp(lateTs);

        vm.expectEmit(true, false, false, true);
        emit StreakReset(alice, 3, uint64(lateTs));
        vm.expectEmit(true, false, false, true);
        emit Claimed(alice, 1, 3, uint64(lateTs), DAY_FEE);
        vm.prank(alice);
        streak.claim();

        assertEq(streak.currentStreak(alice), 1);
        assertEq(streak.longestStreak(alice), 3, "longest preserved");
    }

    function test_Claim_LongestStreakNeverDecreases() public {
        _register(alice);
        vm.warp(START_TS + DAY);
        vm.prank(alice);
        streak.claim(); // streak 2, longest 2

        vm.warp(START_TS + DAY + WINDOW + 1);
        vm.prank(alice);
        streak.claim(); // reset -> 1, longest stays 2
        assertEq(streak.longestStreak(alice), 2);

        vm.warp(START_TS + 2 * DAY + WINDOW + 1);
        vm.prank(alice);
        streak.claim(); // streak 2 again, longest stays 2
        assertEq(streak.currentStreak(alice), 2);
        assertEq(streak.longestStreak(alice), 2);
    }

    function test_Claim_RevertWhenPaused() public {
        _register(alice);
        vm.warp(START_TS + DAY);
        vm.prank(owner);
        streak.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        streak.claim();
    }

    function test_Claim_AfterUnpause() public {
        _register(alice);
        vm.warp(START_TS + DAY);
        vm.prank(owner);
        streak.pause();
        vm.prank(owner);
        streak.unpause();
        vm.prank(alice);
        streak.claim();
        assertEq(streak.currentStreak(alice), 2);
    }

    function test_Claim_RevertAllowanceRevoked() public {
        _register(alice);
        vm.warp(START_TS + DAY);
        vm.prank(alice);
        usdc.approve(address(streak), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InsufficientAllowance.selector, DAY_FEE, 0));
        streak.claim();
    }

    function test_Claim_RevertBalanceDrained() public {
        _register(alice);
        vm.warp(START_TS + DAY);
        uint256 bal = usdc.balanceOf(alice);
        vm.prank(alice);
        usdc.transfer(bob, bal); // drain
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InsufficientBalance.selector, DAY_FEE, 0));
        streak.claim();
    }

    function test_Claim_StateUnchangedOnRevert() public {
        _register(alice);
        vm.warp(START_TS + DAY);
        vm.prank(alice);
        usdc.approve(address(streak), 0);
        vm.prank(alice);
        vm.expectRevert();
        streak.claim();

        // storage rolled back entirely
        assertEq(streak.currentStreak(alice), 1);
        assertEq(streak.lastClaim(alice), uint64(START_TS));
        assertEq(streak.totalCollected(), REG_FEE);
    }

    function test_MultipleUsers_IndependentState() public {
        _register(alice);
        vm.warp(START_TS + 1 hours);
        _register(bob);

        vm.warp(START_TS + DAY);
        vm.prank(alice);
        streak.claim();

        assertEq(streak.currentStreak(alice), 2);
        assertEq(streak.currentStreak(bob), 1);

        // bob cannot claim yet (registered 1h later)
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.ClaimTooEarly.selector, START_TS + 1 hours + DAY));
        streak.claim();

        vm.warp(START_TS + 1 hours + DAY);
        vm.prank(bob);
        streak.claim();
        assertEq(streak.currentStreak(bob), 2);
        assertEq(usdc.balanceOf(address(streak)), 2 * REG_FEE + 2 * DAY_FEE);
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------

    function test_Views_UnregisteredDefaults() public view {
        assertFalse(streak.canClaim(alice));
        assertEq(streak.nextClaimTime(alice), 0);
        assertEq(streak.secondsRemaining(alice), 0);
        assertFalse(streak.isStreakExpired(alice));
        assertEq(streak.currentStreak(alice), 0);
        assertEq(streak.longestStreak(alice), 0);
        assertEq(streak.registeredAt(alice), 0);
        assertEq(streak.lastClaim(alice), 0);
        assertFalse(streak.getUser(alice).exists);
    }

    function test_Views_Lifecycle() public {
        _register(alice);
        assertFalse(streak.canClaim(alice));
        assertEq(streak.nextClaimTime(alice), START_TS + DAY);
        assertEq(streak.secondsRemaining(alice), DAY);

        vm.warp(START_TS + DAY - 1);
        assertEq(streak.secondsRemaining(alice), 1);
        assertFalse(streak.canClaim(alice));

        vm.warp(START_TS + DAY);
        assertTrue(streak.canClaim(alice));
        assertEq(streak.secondsRemaining(alice), 0);
        assertFalse(streak.isStreakExpired(alice));

        vm.warp(START_TS + WINDOW + 1);
        assertTrue(streak.isStreakExpired(alice));
        assertTrue(streak.canClaim(alice)); // claimable, but will reset
    }

    function test_Views_CanClaimFalseWhenPaused() public {
        _register(alice);
        vm.warp(START_TS + DAY);
        vm.prank(owner);
        streak.pause();
        assertFalse(streak.canClaim(alice));
    }

    // -----------------------------------------------------------------
    // Owner: pause / unpause
    // -----------------------------------------------------------------

    function test_Pause_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streak.pause();
    }

    function test_Unpause_OnlyOwner() public {
        vm.prank(owner);
        streak.pause();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streak.unpause();
    }

    function test_Withdraw_WorksWhilePaused() public {
        _register(alice);
        vm.prank(owner);
        streak.pause();
        vm.prank(owner);
        streak.withdraw(REG_FEE);
        assertEq(usdc.balanceOf(treasury), REG_FEE);
    }

    // -----------------------------------------------------------------
    // Owner: withdraw
    // -----------------------------------------------------------------

    function test_Withdraw_HappyPath() public {
        _register(alice);
        _register(bob);

        vm.expectEmit(true, false, false, true);
        emit Withdraw(treasury, REG_FEE);
        vm.prank(owner);
        streak.withdraw(REG_FEE);

        assertEq(usdc.balanceOf(treasury), REG_FEE);
        assertEq(streak.contractBalance(), REG_FEE);
        assertEq(streak.totalWithdrawn(), REG_FEE);
    }

    function test_Withdraw_OnlyOwner() public {
        _register(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streak.withdraw(1);
    }

    function test_Withdraw_RevertZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(ArcDailyStreak.InvalidAmount.selector);
        streak.withdraw(0);
    }

    function test_Withdraw_RevertExceedsBalance() public {
        _register(alice);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.WithdrawExceedsBalance.selector, REG_FEE + 1, REG_FEE));
        streak.withdraw(REG_FEE + 1);
    }

    function test_Withdraw_GoesToTreasuryNotOwner() public {
        _register(alice);
        vm.prank(owner);
        streak.withdraw(REG_FEE);
        assertEq(usdc.balanceOf(owner), 0, "owner must never receive funds");
        assertEq(usdc.balanceOf(treasury), REG_FEE);
    }

    // -----------------------------------------------------------------
    // Owner: treasury
    // -----------------------------------------------------------------

    function test_SetTreasury_HappyPath() public {
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(true, true, false, true);
        emit TreasuryChanged(treasury, newTreasury);
        vm.prank(owner);
        streak.setTreasury(newTreasury);
        assertEq(streak.treasury(), newTreasury);

        _register(alice);
        vm.prank(owner);
        streak.withdraw(REG_FEE);
        assertEq(usdc.balanceOf(newTreasury), REG_FEE);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_SetTreasury_RevertZero() public {
        vm.prank(owner);
        vm.expectRevert(ArcDailyStreak.ZeroAddress.selector);
        streak.setTreasury(address(0));
    }

    function test_SetTreasury_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streak.setTreasury(alice);
    }

    // -----------------------------------------------------------------
    // Ownable2Step
    // -----------------------------------------------------------------

    function test_Ownership_TwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        streak.transferOwnership(newOwner);
        assertEq(streak.owner(), owner, "not transferred until accepted");

        vm.prank(newOwner);
        streak.acceptOwnership();
        assertEq(streak.owner(), newOwner);

        // old owner loses privileges
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        streak.pause();
    }

    function test_Ownership_CannotAcceptUninvited() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        streak.acceptOwnership();
    }

    // -----------------------------------------------------------------
    // Token edge cases
    // -----------------------------------------------------------------

    function test_FeeOnTransferToken_Rejected() public {
        FeeOnTransferUSDC fot = new FeeOnTransferUSDC();
        ArcDailyStreak s2 = new ArcDailyStreak(address(fot), owner, treasury);
        fot.mint(alice, 10 * 1e6);
        vm.startPrank(alice);
        fot.approve(address(s2), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(ArcDailyStreak.TransferFailed.selector, REG_FEE, REG_FEE - REG_FEE / 100)
        );
        s2.register();
        vm.stopPrank();
        assertFalse(s2.getUser(alice).exists, "no profile on failed payment");
    }

    function test_Reentrancy_RegisterBlocked() public {
        ReentrantToken evil = new ReentrantToken();
        ArcDailyStreak s2 = new ArcDailyStreak(address(evil), owner, treasury);
        evil.setTarget(IStreakLike(address(s2)), false);
        evil.mint(alice, 10 * 1e6);
        vm.startPrank(alice);
        evil.approve(address(s2), type(uint256).max);
        // inner register() hits ReentrancyGuard; SafeERC20 bubbles the revert
        vm.expectRevert();
        s2.register();
        vm.stopPrank();
        assertFalse(s2.getUser(alice).exists);
    }

    function test_Reentrancy_ClaimBlocked() public {
        ReentrantToken evil = new ReentrantToken();
        ArcDailyStreak s2 = new ArcDailyStreak(address(evil), owner, treasury);
        evil.mint(alice, 10 * 1e6);
        vm.startPrank(alice);
        evil.approve(address(s2), type(uint256).max);
        s2.register(); // no target set yet -> clean
        vm.stopPrank();

        evil.setTarget(IStreakLike(address(s2)), true);
        vm.warp(block.timestamp + DAY);
        vm.prank(alice);
        vm.expectRevert();
        s2.claim();
        assertEq(s2.currentStreak(alice), 1, "state must not advance");
    }

    function test_NativeTokenRejected() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(streak).call{value: 1 ether}("");
        assertFalse(ok, "no receive/fallback: native transfers revert");
    }

    function test_DirectUSDCDonation_OnlyIncreasesWithdrawable() public {
        usdc.mint(address(streak), 5 * 1e6); // accidental transfer
        assertEq(streak.totalCollected(), 0);
        vm.prank(owner);
        streak.withdraw(5 * 1e6); // recoverable to treasury, not stuck
        assertEq(usdc.balanceOf(treasury), 5 * 1e6);
    }

    // -----------------------------------------------------------------
    // Fuzz tests
    // -----------------------------------------------------------------

    /// @dev Any elapsed time in [24h, 48h] increments; > 48h resets to 1.
    function testFuzz_ClaimIntervalSemantics(uint256 elapsed) public {
        elapsed = bound(elapsed, 0, 365 days);
        _register(alice);
        vm.warp(START_TS + elapsed);
        vm.prank(alice);

        if (elapsed < DAY) {
            vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.ClaimTooEarly.selector, START_TS + DAY));
            streak.claim();
        } else if (elapsed <= WINDOW) {
            streak.claim();
            assertEq(streak.currentStreak(alice), 2);
            assertEq(streak.longestStreak(alice), 2);
        } else {
            streak.claim();
            assertEq(streak.currentStreak(alice), 1);
            assertEq(streak.longestStreak(alice), 1);
        }
    }

    /// @dev Registration works identically for any non-special address.
    function testFuzz_RegisterAnyAddress(address user) public {
        vm.assume(user != address(0) && user.code.length == 0);
        vm.assume(user != address(streak) && user != address(usdc));
        uint256 balBefore = usdc.balanceOf(user);
        usdc.mint(user, REG_FEE);
        vm.startPrank(user);
        usdc.approve(address(streak), REG_FEE);
        streak.register();
        vm.stopPrank();
        ArcDailyStreak.User memory u = streak.getUser(user);
        assertTrue(u.exists);
        assertEq(u.streak, 1);
        assertEq(usdc.balanceOf(user), balBefore, "exactly REG_FEE moved");
    }

    /// @dev Exact-fee accounting holds for any number of claims (<= 60).
    function testFuzz_AccountingMatchesClaims(uint8 claims) public {
        uint256 n = bound(claims, 0, 60);
        _register(alice);
        for (uint256 i = 1; i <= n; i++) {
            vm.warp(START_TS + i * DAY);
            vm.prank(alice);
            streak.claim();
        }
        assertEq(streak.currentStreak(alice), n + 1);
        assertEq(streak.longestStreak(alice), n + 1);
        assertEq(usdc.balanceOf(address(streak)), REG_FEE + n * DAY_FEE);
        assertEq(streak.totalCollected(), REG_FEE + n * DAY_FEE);
    }

    /// @dev Allowance below fee always reverts with the exact custom error;
    ///      allowance >= fee succeeds. No token amount other than the fee moves.
    function testFuzz_AllowanceBoundary(uint256 allowance_) public {
        allowance_ = bound(allowance_, 0, 2 * REG_FEE);
        address user = makeAddr("fuzzUser");
        usdc.mint(user, 10 * 1e6);
        vm.startPrank(user);
        usdc.approve(address(streak), allowance_);
        if (allowance_ < REG_FEE) {
            vm.expectRevert(abi.encodeWithSelector(ArcDailyStreak.InsufficientAllowance.selector, REG_FEE, allowance_));
            streak.register();
        } else {
            streak.register();
            assertEq(usdc.balanceOf(user), 10 * 1e6 - REG_FEE, "exactly the fee moved");
        }
        vm.stopPrank();
    }

    /// @dev Withdrawals of any valid amount preserve balance bookkeeping.
    function testFuzz_Withdraw(uint256 amount) public {
        _register(alice);
        _register(bob);
        uint256 bal = usdc.balanceOf(address(streak));
        amount = bound(amount, 1, bal);
        vm.prank(owner);
        streak.withdraw(amount);
        assertEq(usdc.balanceOf(treasury), amount);
        assertEq(usdc.balanceOf(address(streak)), bal - amount);
        assertEq(streak.totalWithdrawn(), amount);
    }

    /// @dev Timestamp fuzz across multi-claim sequences: longest streak is
    ///      monotone and current streak never exceeds longest.
    function testFuzz_StreakMonotonicity(uint256[8] memory gaps) public {
        _register(alice);
        uint256 ts = START_TS;
        uint32 prevLongest = 1;
        for (uint256 i = 0; i < 8; i++) {
            uint256 gap = bound(gaps[i], 1 hours, 96 hours);
            ts += gap;
            vm.warp(ts);
            vm.prank(alice);
            if (gap < DAY) {
                vm.expectRevert();
                streak.claim();
                ts -= gap; // lastClaim unchanged; keep local clock aligned with it
                vm.warp(ts);
            } else {
                streak.claim();
            }
            uint32 longest = streak.longestStreak(alice);
            assertGe(longest, prevLongest, "longest never decreases");
            assertLe(streak.currentStreak(alice), longest, "current <= longest");
            prevLongest = longest;
        }
    }
}
