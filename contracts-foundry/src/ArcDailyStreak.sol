// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Arc Daily Streak
/// @author Arc Daily Streak contributors
/// @notice On-chain daily streak tracker on Arc Testnet, paid in the official
///         Arc Testnet USDC. Users register once for a fixed 1.00 USDC fee and
///         then pay 0.01 USDC per daily claim to extend their streak.
/// @dev Security model summary:
///      - All economic parameters (token, fees) are immutable/constant and can
///        never be changed after deployment, by anyone, including the owner.
///      - The owner can ONLY: pause, unpause, withdraw collected USDC to the
///        treasury, and rotate the treasury address. The owner can never touch
///        user records, mint, credit, or redirect user funds to itself
///        (withdrawals go exclusively to the treasury).
///      - Collected USDC accumulates inside this contract; nothing is
///        auto-forwarded, so a compromised treasury cannot intercept payment
///        flow and payments can never be griefed by a reverting receiver.
///      - Checks-Effects-Interactions is respected: user storage is finalized
///        before the single external token call in each state-changing path,
///        and every such path is additionally guarded by `nonReentrant`.
///      - The contract has no receive/fallback function, so native-token
///        transfers revert. Only `USDC` is ever pulled via `safeTransferFrom`;
///        arbitrary ERC-20s sent here directly are out of scope by design
///        (they are unrecoverable, which is preferable to adding an owner
///        `sweep` privilege over arbitrary tokens).
///      - `block.timestamp` is used for day accounting. Validator drift is
///        bounded to seconds while the accounting windows are 24h/48h, so
///        timestamp manipulation is economically irrelevant here.
contract ArcDailyStreak is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Per-user streak record, packed into a single 32-byte slot
    ///         (8 + 8 + 4 + 4 + 1 = 25 bytes).
    /// @dev `uint64` timestamps overflow in year ~584e9; `uint32` streaks
    ///      overflow after ~4.29e9 consecutive days. Both are unreachable.
    struct User {
        /// @notice Unix timestamp of registration. Zero means "not registered".
        uint64 registeredAt;
        /// @notice Unix timestamp of the most recent successful claim
        ///         (set to the registration time at registration).
        uint64 lastClaim;
        /// @notice Current consecutive-day streak. Resets to 1 after expiry.
        uint32 streak;
        /// @notice Highest streak ever reached by this user. Never decreases.
        uint32 longestStreak;
        /// @notice Explicit existence flag (redundant with `registeredAt != 0`,
        ///         kept for unambiguous off-chain reads; costs no extra slot).
        bool exists;
    }

    // ---------------------------------------------------------------------
    // Constants & immutables
    // ---------------------------------------------------------------------

    /// @notice One-time registration fee: 1.00 USDC (6 decimals).
    uint256 public constant REGISTRATION_FEE = 1_000_000;

    /// @notice Per-claim fee: 0.01 USDC (6 decimals).
    uint256 public constant DAILY_FEE = 10_000;

    /// @notice Minimum time between two successful claims.
    uint256 public constant CLAIM_INTERVAL = 24 hours;

    /// @notice A streak expires when `block.timestamp > lastClaim + STREAK_WINDOW`.
    ///         The next claim then restarts the streak at 1 (payment still due).
    uint256 public constant STREAK_WINDOW = 48 hours;

    /// @notice Decimals the payment token must report at deployment (USDC = 6).
    uint8 private constant _REQUIRED_DECIMALS = 6;

    /// @notice The official Arc Testnet USDC token. Fixed at deployment forever.
    IERC20 public immutable USDC;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Address that receives withdrawn protocol fees. Intended to be a
    ///         Safe multisig. Never receives funds automatically.
    address public treasury;

    /// @notice Total USDC actually received by this contract through
    ///         `register`/`claim` (measured as balance deltas, so it is exact
    ///         even for non-standard tokens). Monotonically increasing.
    /// @dev Accounting/analytics only; withdrawals are bounded by the live
    ///      balance, not by this counter.
    uint256 public totalCollected;

    /// @notice Total USDC withdrawn to the treasury so far.
    uint256 public totalWithdrawn;

    /// @notice User records keyed by wallet address. O(1) access only; the
    ///         contract intentionally stores no user list and never iterates.
    mapping(address account => User data) private _users;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted once per user upon successful registration.
    /// @param user The registered account.
    /// @param timestamp Registration time (== initial lastClaim).
    /// @param feePaid USDC amount actually received (always REGISTRATION_FEE).
    event Registered(address indexed user, uint64 timestamp, uint256 feePaid);

    /// @notice Emitted on every successful daily claim (including restarts).
    /// @param user The claiming account.
    /// @param streak Streak value after this claim.
    /// @param longestStreak Longest streak after this claim.
    /// @param timestamp Claim time.
    /// @param feePaid USDC amount actually received (always DAILY_FEE).
    event Claimed(address indexed user, uint32 streak, uint32 longestStreak, uint64 timestamp, uint256 feePaid);

    /// @notice Emitted when an expired streak is restarted by a paid claim.
    /// @param user The account whose streak expired.
    /// @param previousStreak The streak value that was lost.
    /// @param timestamp Time of the restarting claim.
    event StreakReset(address indexed user, uint32 previousStreak, uint64 timestamp);

    /// @notice Emitted when collected fees are withdrawn to the treasury.
    /// @param treasury Destination (current treasury at call time).
    /// @param amount USDC amount withdrawn.
    event Withdraw(address indexed treasury, uint256 amount);

    /// @notice Emitted when the treasury address is rotated.
    /// @param previousTreasury Old treasury.
    /// @param newTreasury New treasury.
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice Caller has already registered; registration is once per address.
    error AlreadyRegistered(address user);
    /// @notice Caller has no profile; register first.
    error NotRegistered(address user);
    /// @notice 24 hours have not elapsed since the last claim.
    /// @param nextClaimAt Earliest timestamp at which the claim will succeed.
    error ClaimTooEarly(uint256 nextClaimAt);
    /// @notice Payment token failed deployment validation.
    error InvalidToken(address token);
    /// @notice A zero amount or otherwise invalid amount was supplied.
    error InvalidAmount();
    /// @notice Token balance delta after transferFrom did not equal the fee
    ///         (fee-on-transfer / non-standard token behavior).
    error TransferFailed(uint256 expected, uint256 received);
    /// @notice Caller's USDC allowance for this contract is below the fee.
    error InsufficientAllowance(uint256 required, uint256 current);
    /// @notice Caller's USDC balance is below the fee.
    error InsufficientBalance(uint256 required, uint256 current);
    /// @notice A required address parameter was the zero address.
    error ZeroAddress();
    /// @notice Withdrawal requested more than the contract holds.
    error WithdrawExceedsBalance(uint256 requested, uint256 available);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @notice Deploys the streak contract with all economic parameters fixed.
    /// @dev Reverts unless `usdcToken` is a deployed contract reporting
    ///      6 decimals — a cheap, effective guard against fat-finger deploys
    ///      with a wrong token address. It cannot prove the address is the
    ///      canonical Arc USDC; that is a deploy-time operational check
    ///      (documented in the deployment guide).
    /// @param usdcToken Official Arc Testnet USDC address.
    /// @param initialOwner Admin (pause/unpause/withdraw/setTreasury only).
    /// @param initialTreasury Fee destination; intended to be a Safe multisig.
    constructor(address usdcToken, address initialOwner, address initialTreasury) Ownable(initialOwner) {
        if (usdcToken == address(0) || initialTreasury == address(0)) revert ZeroAddress();
        if (usdcToken.code.length == 0) revert InvalidToken(usdcToken);
        // External call in constructor is safe: no state exists to reenter.
        if (IERC20Metadata(usdcToken).decimals() != _REQUIRED_DECIMALS) revert InvalidToken(usdcToken);

        USDC = IERC20(usdcToken);
        treasury = initialTreasury;
        emit TreasuryChanged(address(0), initialTreasury);
    }

    // ---------------------------------------------------------------------
    // User actions
    // ---------------------------------------------------------------------

    /// @notice Creates the caller's streak profile for exactly 1.00 USDC.
    ///         Callable once per address, ever. Starts the streak at 1.
    /// @dev CEI: all storage writes complete before the token interaction.
    ///      `nonReentrant` is defense-in-depth on top of CEI.
    ///      Requires prior USDC approval of at least REGISTRATION_FEE.
    function register() external nonReentrant whenNotPaused {
        User storage u = _users[msg.sender];
        if (u.exists) revert AlreadyRegistered(msg.sender);

        uint64 nowTs = uint64(block.timestamp);

        // Effects.
        u.registeredAt = nowTs;
        u.lastClaim = nowTs;
        u.streak = 1;
        u.longestStreak = 1;
        u.exists = true;
        totalCollected += REGISTRATION_FEE;

        emit Registered(msg.sender, nowTs, REGISTRATION_FEE);

        // Interaction (reverts roll back all effects above).
        _collectExact(REGISTRATION_FEE);
    }

    /// @notice Extends (or, after expiry, restarts) the caller's streak for
    ///         exactly 0.01 USDC.
    /// @dev Rules:
    ///      - revert if `block.timestamp < lastClaim + 24h` (ClaimTooEarly);
    ///      - if `block.timestamp > lastClaim + 48h` the old streak is lost:
    ///        emits StreakReset and the new streak becomes 1;
    ///      - otherwise streak increments by 1;
    ///      - `longestStreak` is monotone non-decreasing in both branches.
    function claim() external nonReentrant whenNotPaused {
        User storage u = _users[msg.sender];
        if (!u.exists) revert NotRegistered(msg.sender);

        uint256 last = u.lastClaim;
        if (block.timestamp < last + CLAIM_INTERVAL) revert ClaimTooEarly(last + CLAIM_INTERVAL);

        uint64 nowTs = uint64(block.timestamp);
        uint32 newStreak;

        if (block.timestamp > last + STREAK_WINDOW) {
            // Expired: restart. Longest streak is preserved.
            emit StreakReset(msg.sender, u.streak, nowTs);
            newStreak = 1;
        } else {
            newStreak = u.streak + 1;
        }

        // Effects.
        u.streak = newStreak;
        if (newStreak > u.longestStreak) u.longestStreak = newStreak;
        u.lastClaim = nowTs;
        totalCollected += DAILY_FEE;

        emit Claimed(msg.sender, newStreak, u.longestStreak, nowTs, DAILY_FEE);

        // Interaction (reverts roll back all effects above).
        _collectExact(DAILY_FEE);
    }

    // ---------------------------------------------------------------------
    // Owner actions (exhaustive: pause, unpause, withdraw, setTreasury)
    // ---------------------------------------------------------------------

    /// @notice Halts `register` and `claim`. Withdrawals stay enabled so a
    ///         pause can never be used to trap funds away from the treasury.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Re-enables `register` and `claim`.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Withdraws `amount` of collected USDC to the treasury.
    /// @dev Funds can ONLY go to the current treasury — never to the owner or
    ///      an arbitrary address supplied at call time. Works while paused.
    /// @param amount USDC amount to withdraw; must be > 0 and <= balance.
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 available = USDC.balanceOf(address(this));
        if (amount > available) revert WithdrawExceedsBalance(amount, available);

        address to = treasury;
        totalWithdrawn += amount;
        emit Withdraw(to, amount);

        USDC.safeTransfer(to, amount);
    }

    /// @notice Rotates the treasury address (e.g. to a new Safe multisig).
    /// @param newTreasury Non-zero destination for future withdrawals.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryChanged(old, newTreasury);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Full packed record for `account` (zeroed struct if unknown).
    function getUser(address account) external view returns (User memory) {
        return _users[account];
    }

    /// @notice Stored streak of `account`. Note: after the 48h window elapses
    ///         this value is stale until the next paid claim resets it to 1;
    ///         use `isStreakExpired` to detect that state.
    function currentStreak(address account) external view returns (uint32) {
        return _users[account].streak;
    }

    /// @notice Longest streak ever reached by `account`.
    function longestStreak(address account) external view returns (uint32) {
        return _users[account].longestStreak;
    }

    /// @notice Registration timestamp of `account` (0 if not registered).
    function registeredAt(address account) external view returns (uint64) {
        return _users[account].registeredAt;
    }

    /// @notice Last successful claim timestamp of `account`.
    function lastClaim(address account) external view returns (uint64) {
        return _users[account].lastClaim;
    }

    /// @notice True when `account` is registered, the contract is not paused,
    ///         and 24h have elapsed since the last claim. Does not check
    ///         balance/allowance (frontend reads those separately).
    function canClaim(address account) external view returns (bool) {
        User storage u = _users[account];
        return u.exists && !paused() && block.timestamp >= uint256(u.lastClaim) + CLAIM_INTERVAL;
    }

    /// @notice Earliest timestamp at which `account` can claim next
    ///         (0 if not registered).
    function nextClaimTime(address account) external view returns (uint256) {
        User storage u = _users[account];
        if (!u.exists) return 0;
        return uint256(u.lastClaim) + CLAIM_INTERVAL;
    }

    /// @notice Seconds until `account` may claim (0 when claimable or unknown).
    function secondsRemaining(address account) external view returns (uint256) {
        User storage u = _users[account];
        if (!u.exists) return 0;
        uint256 next = uint256(u.lastClaim) + CLAIM_INTERVAL;
        return block.timestamp >= next ? 0 : next - block.timestamp;
    }

    /// @notice True when `account`'s streak has passed the 48h window and the
    ///         next claim will restart it at 1.
    function isStreakExpired(address account) external view returns (bool) {
        User storage u = _users[account];
        return u.exists && block.timestamp > uint256(u.lastClaim) + STREAK_WINDOW;
    }

    /// @notice Current USDC held by this contract (collected, not yet withdrawn,
    ///         plus any direct USDC donations).
    function contractBalance() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @notice One-time registration fee (1.00 USDC, 6 decimals).
    function registrationFee() external pure returns (uint256) {
        return REGISTRATION_FEE;
    }

    /// @notice Per-claim fee (0.01 USDC, 6 decimals).
    function dailyFee() external pure returns (uint256) {
        return DAILY_FEE;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Pulls exactly `amount` USDC from the caller with explicit
    ///      pre-checks (clear custom errors for the frontend) and an exact
    ///      balance-delta assertion (rejects fee-on-transfer behavior so
    ///      internal accounting can never drift from reality).
    /// @param amount Fee to collect; a compile-time constant at both call sites.
    function _collectExact(uint256 amount) private {
        IERC20 token = USDC; // cache immutable-backed reference for clarity

        uint256 allowance_ = token.allowance(msg.sender, address(this));
        if (allowance_ < amount) revert InsufficientAllowance(amount, allowance_);

        uint256 payerBalance = token.balanceOf(msg.sender);
        if (payerBalance < amount) revert InsufficientBalance(amount, payerBalance);

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert TransferFailed(amount, received);
    }
}
