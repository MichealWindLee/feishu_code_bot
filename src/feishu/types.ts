export type ChatType = "p2p" | "group";

export interface MentionInfo {
  openId?: string;
  userId?: string;
  name?: string;
  isBot?: boolean;
}

export interface ResourceDescriptor {
  type: "image" | "file" | "audio" | "video" | "sticker";
  fileKey: string;
  fileName?: string;
}

export interface FeishuMessageEvent {
  kind: "message";
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  content: string;
  mentionedBot: boolean;
  mentions: MentionInfo[];
  resources: ResourceDescriptor[];
  createTime: number;
  raw?: unknown;
}

export interface FeishuCardActionEvent {
  kind: "card_action";
  eventId: string;
  actionId: string;
  messageId: string;
  chatId: string;
  operatorId: string;
  tag: string;
  name?: string;
  option?: string;
  value: unknown;
  raw?: unknown;
}

export interface FeishuBotMenuEvent {
  kind: "bot_menu";
  eventId: string;
  eventKey: string;
  operatorId: string;
  tenantKey?: string;
  raw?: unknown;
}

export interface FeishuReactionEvent {
  kind: "reaction";
  eventId: string;
  messageId: string;
  operatorId: string;
  emojiType: string;
  action: "added" | "removed";
  raw?: unknown;
}

export interface FeishuConnectionEvent {
  kind: "connection";
  status: "connected" | "reconnecting" | "reconnected" | "closed" | "error";
  error?: Error;
}

export type FeishuInboundEvent =
  | FeishuMessageEvent
  | FeishuCardActionEvent
  | FeishuBotMenuEvent
  | FeishuReactionEvent
  | FeishuConnectionEvent;

export interface ReplyTarget {
  chatId: string;
  messageId?: string;
  replyInThread?: boolean;
}

export interface SendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

export interface SendResult {
  messageId: string;
  chunkIds?: string[];
}

export interface ChatInfo {
  chatId: string;
  name?: string;
  chatType: ChatType | "topic";
}

export interface ChatMenuSpec {
  items: Array<{
    name: string;
    actionType?: "NONE" | "REDIRECT_LINK";
    url?: string;
    children?: Array<{ name: string; actionType?: "NONE" | "REDIRECT_LINK"; url?: string }>;
  }>;
}

export interface FeishuGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (event: FeishuInboundEvent) => void | Promise<void>): void;
}

export interface FeishuMessagePort {
  sendMarkdown(target: ReplyTarget, markdown: string, opts?: SendOptions): Promise<SendResult>;
  streamMarkdown(
    target: ReplyTarget,
    stream: AsyncIterable<string>,
    opts?: SendOptions,
  ): Promise<SendResult>;
  sendCard(target: ReplyTarget, card: object, opts?: SendOptions): Promise<SendResult>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export interface FeishuBotAdminPort {
  getChatInfo(chatId: string): Promise<ChatInfo>;
  upsertChatMenu(chatId: string, menu: ChatMenuSpec): Promise<void>;
}
