/** One conversation found by the session search index. */
export interface SessionSearchResult {
  id: string;
  title: string;
  projectId: string | null;
  /** Where the query's words are in `title`, as ranges into it; absent when none are. */
  titleMatches?: Array<[number, number]>;
  /** A line of the chat around the first match, with match ranges into `text`; absent for a title match. */
  snippet?: { text: string; matches: Array<[number, number]> };
}
/** The message a text match was found in, to open the chat there (`sessions:locate-match`). */
export interface SessionSearchLocation {
  /** The message's event, as the timeline holds it. */
  seq: number;
  kind: 'user_message' | 'assistant_message';
  messageId: string | null;
  /** Where the message first appeared, in the timeline's paging order (origin, else seq). */
  position: number;
}
export interface SessionSearchReply {
  results: SessionSearchResult[];
  /** Chats whose words are indexed so far, out of all chats; equal once indexing is done. */
  indexed: number;
  total: number;
  /** More chats match than `results` holds. */
  limited?: true;
}
