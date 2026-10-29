/** An application-authored history failure, safe to explain in chat and logs.
 * Only pass fixed guidance here, never a provider error or message content.
 */
export class HistoryUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryUnavailableError';
    this.code = 'HISTORY_UNAVAILABLE';
  }
}
