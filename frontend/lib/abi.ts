import {parseAbi} from "viem";

/**
 * Human-readable ABI for ArcDailyStreak (generated from Foundry output).
 * Includes every external function, event, and custom error the UI needs.
 */
export const arcDailyStreakAbi = parseAbi([
  // Reads
  "function getUser(address account) view returns ((uint64 registeredAt, uint64 lastClaim, uint32 streak, uint32 longestStreak, bool exists))",
  "function currentStreak(address account) view returns (uint32)",
  "function longestStreak(address account) view returns (uint32)",
  "function registeredAt(address account) view returns (uint64)",
  "function lastClaim(address account) view returns (uint64)",
  "function canClaim(address account) view returns (bool)",
  "function nextClaimTime(address account) view returns (uint256)",
  "function secondsRemaining(address account) view returns (uint256)",
  "function isStreakExpired(address account) view returns (bool)",
  "function contractBalance() view returns (uint256)",
  "function treasury() view returns (address)",
  "function registrationFee() pure returns (uint256)",
  "function dailyFee() pure returns (uint256)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function USDC() view returns (address)",
  "function totalCollected() view returns (uint256)",
  "function totalWithdrawn() view returns (uint256)",
  "function CLAIM_INTERVAL() view returns (uint256)",
  "function STREAK_WINDOW() view returns (uint256)",
  // Writes
  "function register()",
  "function claim()",
  // Events
  "event Registered(address indexed user, uint64 timestamp, uint256 feePaid)",
  "event Claimed(address indexed user, uint32 streak, uint32 longestStreak, uint64 timestamp, uint256 feePaid)",
  "event StreakReset(address indexed user, uint32 previousStreak, uint64 timestamp)",
  "event Withdraw(address indexed treasury, uint256 amount)",
  "event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury)",
  // Custom errors
  "error AlreadyRegistered(address user)",
  "error NotRegistered(address user)",
  "error ClaimTooEarly(uint256 nextClaimAt)",
  "error InvalidToken(address token)",
  "error InvalidAmount()",
  "error TransferFailed(uint256 expected, uint256 received)",
  "error InsufficientAllowance(uint256 required, uint256 current)",
  "error InsufficientBalance(uint256 required, uint256 current)",
  "error ZeroAddress()",
  "error WithdrawExceedsBalance(uint256 requested, uint256 available)",
  "error EnforcedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error OwnableUnauthorizedAccount(address account)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
