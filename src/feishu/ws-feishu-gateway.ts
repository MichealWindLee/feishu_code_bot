import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  normalize,
  normalizeCardAction,
  normalizeReaction,
  type BotIdentity,
  type RawMessageEvent,
} from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../config/types.js";
import type {
  ChatInfo,
  ChatMenuSpec,
  FeishuBotAdminPort,
  FeishuGateway,
  FeishuInboundEvent,
  FeishuMessagePort,
  ReplyTarget,
  SendOptions,
  SendResult,
} from "./types.js";

type EventHandler = (event: FeishuInboundEvent) => void | Promise<void>;

export class WsFeishuGateway implements FeishuGateway, FeishuMessagePort, FeishuBotAdminPort {
  private readonly client: Client;
  private readonly dispatcher: EventDispatcher;
  private readonly handlers: EventHandler[] = [];
  private wsClient: WSClient | null = null;
  private botIdentity: BotIdentity | null = null;

  constructor(private readonly config: AppConfig) {
    this.client = new Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.info,
      source: "feishu-code-bot",
    });
    this.dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.info });
    this.registerDispatcherHandlers();
  }

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.botIdentity = await this.resolveBotIdentity();
    this.wsClient = new WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      loggerLevel: LoggerLevel.info,
      source: "feishu-code-bot",
      onReady: () => void this.emit({ kind: "connection", status: "connected" }),
      onReconnecting: () => void this.emit({ kind: "connection", status: "reconnecting" }),
      onReconnected: () => void this.emit({ kind: "connection", status: "reconnected" }),
      onError: (error) => void this.emit({ kind: "connection", status: "error", error }),
    });
    await this.wsClient.start({ eventDispatcher: this.dispatcher });
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = null;
    await this.emit({ kind: "connection", status: "closed" });
  }

  async sendMarkdown(target: ReplyTarget, markdown: string, opts: SendOptions = {}): Promise<SendResult> {
    const replyTo = opts.replyTo ?? target.messageId;
    if (replyTo) {
      const response = await this.client.im.v1.message.reply({
        path: { message_id: replyTo },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: markdown }),
          reply_in_thread: opts.replyInThread ?? target.replyInThread,
        },
      } as never);
      return { messageId: extractMessageId(response) };
    }

    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: target.chatId,
        msg_type: "text",
        content: JSON.stringify({ text: markdown }),
      },
    } as never);
    return { messageId: extractMessageId(response) };
  }

  async streamMarkdown(
    target: ReplyTarget,
    stream: AsyncIterable<string>,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    let fullText = "";
    let result: SendResult | null = null;
    let lastFlush = 0;

    for await (const chunk of stream) {
      fullText += chunk;
      const now = Date.now();
      if (!result) {
        result = await this.sendMarkdown(target, fullText || "Codex is working...", opts);
        lastFlush = now;
      } else if (now - lastFlush >= this.config.bot.streamFlushMs) {
        await this.updateTextMessage(result.messageId, fullText);
        lastFlush = now;
      }
    }

    if (!result) {
      return this.sendMarkdown(target, "Codex completed without textual output.", opts);
    }
    await this.updateTextMessage(result.messageId, fullText || "Codex completed without textual output.");
    return result;
  }

  async sendCard(target: ReplyTarget, card: object, opts: SendOptions = {}): Promise<SendResult> {
    const replyTo = opts.replyTo ?? target.messageId;
    const payload = {
      msg_type: "interactive",
      content: JSON.stringify(card),
      reply_in_thread: opts.replyInThread ?? target.replyInThread,
    };

    if (replyTo) {
      const response = await this.client.im.v1.message.reply({
        path: { message_id: replyTo },
        data: payload,
      } as never);
      return { messageId: extractMessageId(response) };
    }

    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: target.chatId,
        ...payload,
      },
    } as never);
    return { messageId: extractMessageId(response) };
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    } as never);
  }

  async getChatInfo(chatId: string): Promise<ChatInfo> {
    const response = await this.client.im.v1.chat.get({ path: { chat_id: chatId } } as never);
    const data = (response as { data?: { name?: string; chat_mode?: string } }).data;
    return {
      chatId,
      name: data?.name,
      chatType: data?.chat_mode === "p2p" || data?.chat_mode === "topic" ? data.chat_mode : "group",
    };
  }

  async upsertChatMenu(chatId: string, menu: ChatMenuSpec): Promise<void> {
    await this.client.im.v1.chatMenuTree.create({
      path: { chat_id: chatId },
      data: {
        menu_tree: {
          chat_menu_top_levels: menu.items.map((item) => ({
            chat_menu_item: {
              name: item.name,
              action_type: item.actionType ?? "NONE",
              redirect_link: item.url ? { common_url: item.url } : undefined,
            },
            children: item.children?.map((child) => ({
              chat_menu_item: {
                name: child.name,
                action_type: child.actionType ?? "NONE",
                redirect_link: child.url ? { common_url: child.url } : undefined,
              },
            })),
          })),
        },
      },
    } as never);
  }

  private registerDispatcherHandlers(): void {
    this.dispatcher.register({
      "im.message.receive_v1": async (raw: RawMessageEvent & { event_id?: string }) => {
        if (!this.botIdentity) return;
        const normalized = await normalize(raw as RawMessageEvent, {
          botIdentity: this.botIdentity,
          stripBotMentions: true,
          includeRaw: true,
          fetchSubMessages: async () => [],
        });
        await this.emit({
          kind: "message",
          eventId: raw.event_id ?? normalized.messageId,
          messageId: normalized.messageId,
          chatId: normalized.chatId,
          chatType: normalized.chatType,
          senderId: normalized.senderId,
          senderName: normalized.senderName,
          content: normalized.content,
          mentionedBot: normalized.mentionedBot,
          mentions: normalized.mentions,
          resources: normalized.resources,
          createTime: normalized.createTime,
          raw,
        });
      },
      "card.action.trigger": async (raw: Record<string, unknown> & { event_id?: string }) => {
        const normalized = normalizeCardAction(raw as never, { includeRaw: true });
        if (!normalized) return;
        await this.emit({
          kind: "card_action",
          eventId: raw.event_id ?? normalized.messageId,
          actionId: makeCardActionId(normalized.action),
          messageId: normalized.messageId,
          chatId: normalized.chatId,
          operatorId: normalized.operator.openId,
          tag: normalized.action.tag,
          name: normalized.action.name,
          option: normalized.action.option,
          value: normalized.action.value,
          raw,
        });
      },
      "application.bot.menu_v6": async (raw: {
        event_id?: string;
        tenant_key?: string;
        event_key?: string;
        operator?: { operator_id?: { open_id?: string } };
      }) => {
        const operatorId = raw.operator?.operator_id?.open_id;
        if (!raw.event_key || !operatorId) return;
        await this.emit({
          kind: "bot_menu",
          eventId: raw.event_id ?? `${operatorId}:${raw.event_key}`,
          eventKey: raw.event_key,
          operatorId,
          tenantKey: raw.tenant_key,
          raw,
        });
      },
      "im.message.reaction.created_v1": async (raw: Record<string, unknown> & { event_id?: string }) => {
        const normalized = normalizeReaction(raw as never, "added", { includeRaw: true });
        if (!normalized) return;
        await this.emit({
          kind: "reaction",
          eventId: raw.event_id ?? `${normalized.messageId}:${normalized.operator.openId}:added`,
          messageId: normalized.messageId,
          operatorId: normalized.operator.openId,
          emojiType: normalized.emojiType,
          action: "added",
          raw,
        });
      },
      "im.message.reaction.deleted_v1": async (raw: Record<string, unknown> & { event_id?: string }) => {
        const normalized = normalizeReaction(raw as never, "removed", { includeRaw: true });
        if (!normalized) return;
        await this.emit({
          kind: "reaction",
          eventId: raw.event_id ?? `${normalized.messageId}:${normalized.operator.openId}:removed`,
          messageId: normalized.messageId,
          operatorId: normalized.operator.openId,
          emojiType: normalized.emojiType,
          action: "removed",
          raw,
        });
      },
    } as never);
  }

  private async resolveBotIdentity(): Promise<BotIdentity> {
    if (this.config.feishu.botOpenId) {
      return { openId: this.config.feishu.botOpenId, name: "bot" };
    }
    const response = (await this.client.request({
      url: "/open-apis/bot/v3/info",
      method: "GET",
    })) as { bot?: { open_id?: string; app_name?: string } };
    if (!response.bot?.open_id) {
      throw new Error("Unable to resolve bot identity. Set feishu.botOpenId or FEISHU_BOT_OPEN_ID.");
    }
    return { openId: response.bot.open_id, name: response.bot.app_name ?? "bot" };
  }

  private async updateTextMessage(messageId: string, text: string): Promise<void> {
    await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    } as never);
  }

  private async emit(event: FeishuInboundEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}

function extractMessageId(response: unknown): string {
  const data = (response as { data?: { message_id?: string } }).data;
  if (!data?.message_id) throw new Error(`Feishu response missing message_id: ${JSON.stringify(response)}`);
  return data.message_id;
}

function makeCardActionId(action: { tag: string; name?: string; option?: string; value: unknown }): string {
  const value = typeof action.value === "string" ? action.value : JSON.stringify(action.value ?? "");
  return `${action.tag}|${action.name ?? ""}|${action.option ?? ""}|${value.slice(0, 128)}`;
}
