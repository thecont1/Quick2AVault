import { collectIncrementalMessageIds, type GmailHistoryRecord } from "./gmail-model.js";

export interface GmailTransport {
  get<T>(route: string): Promise<T>;
}

interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string }>;
  nextPageToken?: string;
}

interface GmailHistoryResponse {
  history?: GmailHistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

export interface GmailSyncSource {
  profile(): Promise<GmailProfile>;
  initialMessageIds(): Promise<{ messageIds: string[]; historyId: string }>;
  historySince(startHistoryId: string): Promise<{
    history: GmailHistoryRecord[];
    historyId: string;
  }>;
}

export function createGmailSyncSource(
  transport: GmailTransport,
  options: { initialQuery: string; initialLimit: number },
): GmailSyncSource {
  const profile = () => transport.get<GmailProfile>("/profile");
  return {
    profile,
    async initialMessageIds() {
      // Capture before listing: messages arriving during bootstrap are then
      // replayed by the first history request rather than falling into a gap.
      const historyId = (await profile()).historyId;
      const messageIds: string[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q: options.initialQuery, maxResults: "100" });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await transport.get<GmailListResponse>(`/messages?${params}`);
        for (const message of page.messages ?? []) {
          if (messageIds.length >= options.initialLimit) break;
          messageIds.push(message.id);
        }
        pageToken = messageIds.length < options.initialLimit ? page.nextPageToken : undefined;
      } while (pageToken);
      return { messageIds, historyId };
    },
    async historySince(startHistoryId) {
      const history: GmailHistoryRecord[] = [];
      let pageToken: string | undefined;
      let historyId = startHistoryId;
      do {
        const params = new URLSearchParams({
          startHistoryId,
          historyTypes: "messageAdded",
          maxResults: "100",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await transport.get<GmailHistoryResponse>(`/history?${params}`);
        history.push(...(page.history ?? []));
        historyId = page.historyId || historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { history, historyId };
    },
  };
}

export function historyMessageIds(history: GmailHistoryRecord[]): string[] {
  return collectIncrementalMessageIds(history);
}
