import {BaseError, ContractFunctionRevertedError} from "viem";

/**
 * Maps ArcDailyStreak custom errors (and common wallet/RPC failures) to
 * clear, human-readable messages. The contract is the source of truth; the
 * UI only translates its reverts.
 */
export function explainError(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      const args = (revert.data?.args ?? []) as readonly unknown[];
      switch (name) {
        case "AlreadyRegistered":
          return "This wallet is already registered. Registration happens only once.";
        case "NotRegistered":
          return "This wallet has no streak profile yet. Register first (1.00 USDC).";
        case "ClaimTooEarly": {
          const next = args[0] ? new Date(Number(args[0]) * 1000) : null;
          return next
            ? `Too early — you can claim again at ${next.toLocaleString()}.`
            : "Too early — 24 hours must pass since your last claim.";
        }
        case "InsufficientAllowance":
          return "USDC allowance is too low. Approve the fee first, wait for the approval to confirm, then retry.";
        case "InsufficientBalance":
          return "Your USDC balance is too low to pay the fee. Get Arc Testnet USDC from the faucet.";
        case "TransferFailed":
          return "The token transfer did not deliver the exact fee amount. Transaction was rolled back.";
        case "InvalidAmount":
          return "Amount must be greater than zero.";
        case "ZeroAddress":
          return "Zero address is not allowed.";
        case "WithdrawExceedsBalance":
          return "Withdrawal exceeds the contract balance.";
        case "EnforcedPause":
          return "The contract is currently paused by the administrator. Try again later.";
        case "ReentrancyGuardReentrantCall":
          return "Reentrant call blocked.";
        case "OwnableUnauthorizedAccount":
          return "Only the contract owner can perform this action.";
        default:
          if (name) return `Contract rejected the call: ${name}`;
      }
    }
    if (err.shortMessage?.includes("User rejected")) {
      return "Transaction was rejected in the wallet.";
    }
    return err.shortMessage ?? "Transaction failed.";
  }
  if (err instanceof Error) return err.message;
  return "Unknown error.";
}
