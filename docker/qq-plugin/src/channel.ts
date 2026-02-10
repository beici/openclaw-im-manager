import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";
import { startFileServer, stopFileServer } from "./file-server.js";
import { createEventRouter } from "./events/index.js";
import { getMessageCache } from "./utils/message-cache.js";
import { parseApprovalCommand, getPendingRequests } from "./utils/pending-requests.js";
import * as fs from "fs";
import * as path from "path";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

let lastActiveUser: { userId: number; isGroup: boolean; groupId?: number } | null = null;
const sessionToUserMap = new Map<string, { userId: number; isGroup: boolean; groupId?: number }>();

// ===== 消息发送频率限制：上次发送时间记录表 =====
// key 为会话标识（perSession=true 时）或 "__global__"（perSession=false 时）
// value 为上次成功发送消息的时间戳（毫秒）
const lastSendTimeMap = new Map<string, number>();

const FILE_SERVER_PORT = 18790;
// 使用宿主机的Docker网桥IP，让Docker容器中的NapCat可以访问
const FILE_SERVER_BASE_URL = "http://172.17.107.147:" + FILE_SERVER_PORT;

function normalizeTarget(raw: string): string {
  let target = raw.replace(/^(qq:)/i, "");

  if (target === "bot" && lastActiveUser) {
    if (lastActiveUser.isGroup && lastActiveUser.groupId) {
      return "group:" + lastActiveUser.groupId;
    }
    return String(lastActiveUser.userId);
  }

  if (!/^\d+$/.test(target) && !target.startsWith("group:")) {
    const mapping = sessionToUserMap.get("qq:" + target) || sessionToUserMap.get(target);
    if (mapping) {
      if (mapping.isGroup && mapping.groupId) {
        return "group:" + mapping.groupId;
      }
      return String(mapping.userId);
    }

    if (lastActiveUser) {
      if (lastActiveUser.isGroup && lastActiveUser.groupId) {
        return "group:" + lastActiveUser.groupId;
      }
      return String(lastActiveUser.userId);
    }
  }

  return target;
}

function looksLikeQQTargetId(raw: string, normalized: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^qq:bot$/i.test(trimmed)) return lastActiveUser !== null;
  if (/^qq:\d+$/i.test(trimmed)) return true;
  if (/^group:\d+$/i.test(trimmed)) return true;
  if (/^\d{5,}$/.test(trimmed)) return true;
  if (sessionToUserMap.has(trimmed) || sessionToUserMap.has("qq:" + trimmed)) return true;
  if (lastActiveUser) return true;
  return false;
}

const clients = new Map<string, OneBotClient>();

export function getClientForAccount(accountId: string) {
  return clients.get(accountId);
}

// 文件服务器支持的目录白名单（需与 file-server.ts 中的 ALLOWED_DIRS 一致）
const SERVED_DIRS = [
  "/root/openclaw/work",
  "/root/.openclaw",
  "/tmp",
];

function convertLocalPathToUrl(filePath: string): string {
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return filePath;
  }

  if (filePath.startsWith("base64://")) {
    return filePath;
  }

  // 检查是否是文件服务器可以提供的本地路径
  const isServedPath = SERVED_DIRS.some(dir => filePath.startsWith(dir + "/") || filePath === dir);

  if (isServedPath) {
    // 使用 /file?path= 端点，支持任意白名单目录下的文件
    const url = FILE_SERVER_BASE_URL + "/file?path=" + encodeURIComponent(filePath);
    console.log("[QQ] Converted local path to URL: " + filePath + " -> " + url);
    return url;
  }

  // 对于其他绝对路径，也尝试通过文件服务器提供（会被白名单检查拦截）
  if (filePath.startsWith("/") && fs.existsSync(filePath)) {
    const url = FILE_SERVER_BASE_URL + "/file?path=" + encodeURIComponent(filePath);
    console.log("[QQ] Attempting to serve local path via file server: " + filePath + " -> " + url);
    return url;
  }

  return filePath;
}

function detectMediaType(url: string): "image" | "audio" | "video" | "file" {
  const lowerUrl = url.toLowerCase();

  // 检查扩展名
  const ext = path.extname(url).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
    return "image";
  }
  if ([".mp3", ".wav", ".amr", ".silk", ".ogg"].includes(ext)) {
    return "audio";
  }
  if ([".mp4", ".avi", ".mov", ".mkv"].includes(ext)) {
    return "video";
  }

  // 检查URL路径中的关键词
  if (lowerUrl.includes("/image/") || lowerUrl.includes("/img/") || lowerUrl.includes("/photo/")) {
    return "image";
  }
  if (lowerUrl.includes("/audio/") || lowerUrl.includes("/sound/")) {
    return "audio";
  }
  if (lowerUrl.includes("/video/")) {
    return "video";
  }

  // 检查常见图片服务域名
  if (lowerUrl.includes("picsum.photos") || lowerUrl.includes("placeholder.com") ||
    lowerUrl.includes("lorempixel.com") || lowerUrl.includes("loremflickr.com") ||
    lowerUrl.includes("httpbin.org/image")) {
    return "image";
  }

  return "file";
}

function buildMessage(text?: string, files?: Array<{ url?: string; name?: string; mimeType?: string }>): OneBotMessage {
  const segments: OneBotMessageSegment[] = [];

  if (text) {
    segments.push({ type: "text", data: { text } });
  }

  if (files && files.length > 0) {
    for (const file of files) {
      if (!file.url) continue;

      const processedUrl = convertLocalPathToUrl(file.url);
      const mimeType = file.mimeType || "";

      if (mimeType.startsWith("image/")) {
        segments.push({ type: "image", data: { file: processedUrl } });
      } else if (mimeType.startsWith("audio/")) {
        segments.push({ type: "record", data: { file: processedUrl } });
      } else if (mimeType.startsWith("video/")) {
        segments.push({ type: "video", data: { file: processedUrl } });
      } else {
        segments.push({ type: "image", data: { file: processedUrl } });
      }
    }
  }

  return segments.length > 0 ? segments : [{ type: "text", data: { text: "" } }];
}

async function sendFileToTarget(
  client: OneBotClient,
  to: string,
  fileUrl: string,
  fileName: string
): Promise<boolean> {
  const target = normalizeTarget(to);
  const processedUrl = convertLocalPathToUrl(fileUrl);

  console.log("[QQ] sendFileToTarget: to=" + to + ", file=" + processedUrl);

  if (target.startsWith("group:")) {
    const groupId = parseInt(target.replace("group:", ""), 10);
    if (isNaN(groupId)) return false;
    await client.uploadGroupFile(groupId, processedUrl, fileName);
    return true;
  } else if (/^\d+$/.test(target)) {
    const userId = parseInt(target, 10);
    await client.uploadPrivateFile(userId, processedUrl, fileName);
    return true;
  }

  return false;
}

async function sendToTarget(client: OneBotClient, to: string, message: OneBotMessage): Promise<boolean> {
  const target = normalizeTarget(to);

  if (target.startsWith("group:")) {
    const groupId = parseInt(target.replace("group:", ""), 10);
    if (isNaN(groupId)) return false;
    await client.sendGroupMsg(groupId, message);
    return true;
  } else if (/^\d+$/.test(target)) {
    const userId = parseInt(target, 10);
    await client.sendPrivateMsg(userId, message);
    return true;
  }

  return false;
}

// ===== 检查消息中是否 @了指定的 Bot QQ 号 =====
// 遍历消息段，查找 type 为 "at" 的段，比较其 qq 字段是否匹配 Bot 的 selfId
// 参数 message: OneBot 消息段数组; selfId: Bot 自身的 QQ 号
// 返回 true 表示消息中包含 @Bot
function checkAtBot(message: any, selfId: number): boolean {
  // 安全校验：消息必须是数组且 selfId 有效（大于 0）
  if (!Array.isArray(message) || selfId <= 0) return false;
  for (const seg of message) {
    if (seg.type === "at") {
      // at 段的 qq 字段可能是字符串或数字，统一转为字符串比较
      const atQQ = String(seg.data?.qq || "");
      if (atQQ === String(selfId)) {
        return true;
      }
    }
  }
  return false;
}

// ===== 群聊唤醒条件判断 =====
// 根据配置的唤醒规则判断是否应该响应群聊消息
// 返回 { shouldReply: boolean, reason: string }
// 参数说明：
//   text: 消息文本内容
//   message: OneBot 原始消息段数组（用于检测 @）
//   selfId: Bot 自身 QQ 号
//   wakeupConfig: 唤醒配置（来自 openclaw.json）
function checkGroupWakeup(
  text: string,
  message: any,
  selfId: number,
  wakeupConfig: {
    probability?: number;
    replyOnAt?: boolean;
    names?: string[];
    keywords?: string[];
    matchLogic?: "or" | "and";
  } | undefined
): { shouldReply: boolean; reason: string } {
  // 如果没有配置唤醒规则，默认允许所有消息通过
  if (!wakeupConfig) {
    return { shouldReply: true, reason: "no_wakeup_config" };
  }

  const lowerText = text.toLowerCase();

  // ===== 第一步：检查各个显式触发条件 =====
  // 显式条件包括：提及名字、@Bot、关键词匹配
  // 这些条件根据 matchLogic 配置进行 "或"/"且" 组合判断

  // 存储各个已配置条件的匹配结果
  // 只有实际配置了的条件才会加入此数组（未配置的条件不参与判断）
  const conditions: { name: string; matched: boolean }[] = [];

  // 条件1：检查消息中是否包含配置的唤醒名字（不区分大小写）
  if (wakeupConfig.names && wakeupConfig.names.length > 0) {
    const hasName = wakeupConfig.names.some(
      name => name.length > 0 && lowerText.includes(name.toLowerCase())
    );
    conditions.push({ name: "name_mention", matched: hasName });
  }

  // 条件2：检查消息中是否 @了 Bot（需要 replyOnAt 开启且 selfId 有效）
  if (wakeupConfig.replyOnAt === true) {
    const hasAt = checkAtBot(message, selfId);
    conditions.push({ name: "at_bot", matched: hasAt });
  }

  // 条件3：检查消息中是否包含配置的关键词（不区分大小写）
  if (wakeupConfig.keywords && wakeupConfig.keywords.length > 0) {
    const hasKeyword = wakeupConfig.keywords.some(
      kw => kw.length > 0 && lowerText.includes(kw.toLowerCase())
    );
    conditions.push({ name: "keyword", matched: hasKeyword });
  }

  // ===== 第二步：根据 matchLogic 合并显式条件 =====
  let explicitTrigger = false;

  if (conditions.length > 0) {
    const matchLogic = wakeupConfig.matchLogic || "or";
    if (matchLogic === "or") {
      // "or" 模式：任一显式条件满足即触发
      explicitTrigger = conditions.some(c => c.matched);
    } else {
      // "and" 模式：所有已配置的显式条件都必须满足才触发
      explicitTrigger = conditions.every(c => c.matched);
    }
  }

  // 如果显式条件命中，直接返回，记录触发原因
  if (explicitTrigger) {
    const matchedNames = conditions.filter(c => c.matched).map(c => c.name).join("+");
    return { shouldReply: true, reason: matchedNames };
  }

  // ===== 第三步：随机概率作为独立的回退机制 =====
  // 随机概率不参与 and/or 逻辑，而是作为独立的兜底触发
  // 当显式条件都未命中时，以配置的概率随机触发
  const probability = (wakeupConfig.probability ?? 10) / 100;

  // 安全校验：概率值必须在 0-1 之间
  const safeProbability = Math.max(0, Math.min(1, probability));

  if (safeProbability > 0 && Math.random() < safeProbability) {
    return { shouldReply: true, reason: "random(" + (safeProbability * 100) + "%)" };
  }

  // 所有条件都未满足，不回复
  return { shouldReply: false, reason: "no_trigger" };
}

// ===== 消息发送频率限制校验 =====
// 检查距离上次发送是否已超过最小间隔时间
// 参数说明：
//   sessionKey: 会话标识（如 "qq:group:123456"）
//   rateLimitConfig: 频率限制配置
// 返回 true 表示允许发送，false 表示应被限流
function checkRateLimit(
  sessionKey: string,
  rateLimitConfig: { minInterval?: number; perSession?: boolean } | undefined
): boolean {
  // 未配置频率限制或间隔为 0 时，不做限制
  if (!rateLimitConfig || !rateLimitConfig.minInterval || rateLimitConfig.minInterval <= 0) {
    return true;
  }

  const now = Date.now();
  // 根据 perSession 配置决定使用会话级别还是全局级别的时间记录
  // perSession=true（默认）：每个群、每个私聊各自独立计时
  // perSession=false：所有会话共享一个全局计时器
  const rateLimitKey = (rateLimitConfig.perSession !== false) ? sessionKey : "__global__";
  const lastSendTime = lastSendTimeMap.get(rateLimitKey) || 0;

  // 计算距离上次发送的时间差（毫秒），与配置的最小间隔（秒）进行比较
  const elapsedMs = now - lastSendTime;
  const minIntervalMs = rateLimitConfig.minInterval * 1000;

  if (elapsedMs < minIntervalMs) {
    // 时间间隔不足，本次消息应被限流跳过
    const remainingSec = ((minIntervalMs - elapsedMs) / 1000).toFixed(1);
    console.log(`[QQ] Rate limited: elapsed ${(elapsedMs / 1000).toFixed(1)}s < min ${rateLimitConfig.minInterval}s (${remainingSec}s remaining, key=${rateLimitKey})`);
    return false;
  }

  return true;
}

// ===== 记录消息发送时间（在实际发送成功后调用）=====
// 更新频率限制的上次发送时间记录
function recordSendTime(
  sessionKey: string,
  rateLimitConfig: { perSession?: boolean } | undefined
): void {
  const rateLimitKey = (rateLimitConfig?.perSession !== false) ? sessionKey : "__global__";
  lastSendTimeMap.set(rateLimitKey, Date.now());
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11 (NapCat)",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
      // @ts-ignore
      const qq = cfg.channels?.qq;
      if (!qq) return [];
      if (qq.accounts) return Object.keys(qq.accounts);
      return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
      const id = accountId ?? DEFAULT_ACCOUNT_ID;
      // @ts-ignore
      const qq = cfg.channels?.qq;
      const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];

      return {
        accountId: id,
        name: accountConfig?.name ?? "QQ Default",
        enabled: true,
        configured: Boolean(accountConfig?.wsUrl),
        tokenSource: accountConfig?.accessToken ? "config" : "none",
        config: accountConfig || {},
      };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({
      accountId: acc.accountId,
      configured: acc.configured,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, cfg } = ctx;
      const config = account.config;

      if (!config.wsUrl) {
        throw new Error("QQ: wsUrl is required");
      }

      startFileServer(FILE_SERVER_PORT);

      const client = new OneBotClient({
        wsUrl: config.wsUrl,
        accessToken: config.accessToken,
      });

      clients.set(account.accountId, client);

      client.on("connect", () => {
        console.log("[QQ] Connected account " + account.accountId);
        try {
          getQQRuntime().channel.activity.record({
            channel: "qq",
            accountId: account.accountId,
            direction: "inbound",
          });
        } catch (err) { }
      });

      // 获取机器人自身QQ号
      let selfId = 0;
      client.on("connect", async () => {
        try {
          const loginInfo = await client.getLoginInfo();
          selfId = loginInfo.data?.user_id || 0;
          console.log("[QQ] Bot QQ ID: " + selfId);
        } catch (err) {
          console.error("[QQ] Failed to get login info:", err);
        }
      });

      // 通知主人的快捷方法
      const notifyOwner = async (text: string) => {
        const ownerQQ = config.ownerQQ;
        if (!ownerQQ) {
          console.log("[QQ] No ownerQQ configured, skipping notification: " + text.substring(0, 50));
          return;
        }
        try {
          await client.sendPrivateMsg(ownerQQ, [{ type: "text", data: { text } }]);
        } catch (err) {
          console.error("[QQ] Failed to notify owner:", err);
        }
      };

      // 创建事件路由器
      const eventRouter = createEventRouter({ client, config, selfId, notifyOwner });

      client.on("message", async (event) => {
        // 非 message 事件交给事件路由器处理
        if (event.post_type !== "message") {
          // 动态传入最新的 selfId
          await createEventRouter({ client, config, selfId, notifyOwner })(event);
          return;
        }

        // 缓存消息（用于防撤回）
        if (event.message_id && event.raw_message) {
          getMessageCache().set(event.message_id, {
            text: event.raw_message,
            userId: event.user_id || 0,
            groupId: event.group_id,
            time: event.time,
          });
        }

        const isGroup = event.message_type === "group";
        const userId = event.user_id;
        const groupId = event.group_id;
        let text = event.raw_message || "";

        // 如果消息为空但包含图片/文件等媒体，添加描述性文本避免OpenClaw发送"没收到文本"的提示
        if (!text && event.message && Array.isArray(event.message)) {
          const mediaTypes = event.message.map((seg: any) => seg.type).filter((t: string) => t !== "text");
          if (mediaTypes.length > 0) {
            const descriptions = mediaTypes.map((type: string) => {
              if (type === "image") return "[图片]";
              if (type === "file") return "[文件]";
              if (type === "video") return "[视频]";
              if (type === "record") return "[语音]";
              return `[${type}]`;
            });
            text = descriptions.join(" ");
          }
        }

        // 如果消息仍然为空（可能是系统消息或回执），忽略不处理
        if (!text || text.trim() === "") {
          console.log("[QQ] Ignoring empty message event");
          return;
        }

        // 检查是否是主人的审核回复指令
        if (!isGroup && userId && userId === config.ownerQQ && text) {
          const cmd = parseApprovalCommand(text);
          if (cmd) {
            const req = getPendingRequests().get(cmd.flag);
            if (req) {
              try {
                if (cmd.type === "group") {
                  await client.setGroupAddRequest(cmd.flag, req.subType || "add", cmd.action === "approve", cmd.reason || "");
                } else {
                  await client.setFriendAddRequest(cmd.flag, cmd.action === "approve", cmd.reason || "");
                }
                getPendingRequests().delete(cmd.flag);
                const actionText = cmd.action === "approve" ? "同意" : "拒绝";
                const typeText = cmd.type === "group" ? "入群" : "好友";
                await notifyOwner(`✅ 已${actionText}${typeText}请求`);
              } catch (err) {
                await notifyOwner(`❌ 处理请求失败: ${err}`);
              }
              return; // 审核指令不转发给 Agent
            }
          }
        }

        const fromId = isGroup ? "group:" + groupId : String(userId);
        const sessionKey = "qq:" + fromId;

        // ===== 私聊消息：根据 alwaysReplyPrivate 配置决定是否跳过过滤 =====
        if (!isGroup) {
          const alwaysReply = config.wakeup?.alwaysReplyPrivate ?? true;
          if (!alwaysReply) {
            // alwaysReplyPrivate 为 false 时，私聊也需要经过唤醒条件判断
            const wakeupResult = checkGroupWakeup(text, event.message, selfId, config.wakeup);
            if (!wakeupResult.shouldReply) {
              console.log("[QQ] Private message filtered by wakeup config: " + text.substring(0, 50));
              return;
            }
            console.log("[QQ] Private message triggered by: " + wakeupResult.reason);
          }
          // alwaysReplyPrivate 为 true（默认）时，私聊消息直接通过
        }

        // ===== 群聊唤醒条件判断（使用配置驱动的判断逻辑） =====
        if (isGroup) {
          const wakeupResult = checkGroupWakeup(text, event.message, selfId, config.wakeup);
          if (!wakeupResult.shouldReply) {
            console.log("[QQ] Group message filtered (no trigger): " + text.substring(0, 50));
            return;
          }
          console.log("[QQ] Group message triggered by: " + wakeupResult.reason);
        }

        // ===== 消息发送频率限制校验 =====
        // 在唤醒条件通过后、实际处理消息前，检查频率限制
        if (!checkRateLimit(sessionKey, config.rateLimit)) {
          console.log("[QQ] Message skipped due to rate limit: " + text.substring(0, 50));
          return;
        }

        if (userId) {
          lastActiveUser = { userId, isGroup, groupId };
          sessionToUserMap.set(sessionKey, lastActiveUser);
          sessionToUserMap.set(String(userId), lastActiveUser);
          sessionToUserMap.set("bot", lastActiveUser);
          sessionToUserMap.set("qq:bot", lastActiveUser);
        }

        const runtime = getQQRuntime();

        const deliver = async (payload: ReplyPayload) => {
          try {
            const message = buildMessage(payload.text, payload.files);
            console.log("[QQ] Delivering: " + JSON.stringify(message).substring(0, 300));

            if (isGroup && groupId) {
              await client.sendGroupMsg(groupId, message);
            } else if (userId) {
              await client.sendPrivateMsg(userId, message);
            }

            // ===== 消息成功发送后，记录发送时间用于频率限制 =====
            recordSendTime(sessionKey, config.rateLimit);
          } catch (err) {
            console.error("[QQ] Deliver error:", err);
          }
        };

        const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Provider: "qq",
          Channel: "qq",
          From: fromId,
          To: fromId,
          Body: text,
          RawBody: text,
          SenderId: String(userId),
          SenderName: event.sender?.nickname || "Unknown",
          ConversationLabel: isGroup ? "QQ Group " + groupId : "QQ User " + userId,
          SessionKey: sessionKey,
          AccountId: account.accountId,
          ChatType: isGroup ? "group" : "direct",
          Timestamp: event.time * 1000,
          OriginatingChannel: "qq",
          OriginatingTo: fromId,
          CommandAuthorized: true
        });

        await runtime.channel.session.recordInboundSession({
          storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
          sessionKey: ctxPayload.SessionKey!,
          ctx: ctxPayload,
          updateLastRoute: {
            sessionKey: ctxPayload.SessionKey!,
            channel: "qq",
            to: fromId,
            accountId: account.accountId,
          },
          onRecordError: (err) => console.error("QQ Session Error:", err)
        });

        await runtime.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });
      });

      client.connect();

      return () => {
        client.disconnect();
        clients.delete(account.accountId);
        stopFileServer();
      };
    },
  },
  outbound: {
    sendText: async ({ to, text, accountId }) => {
      const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
      if (!client) {
        return { channel: "qq", sent: false, error: "Client not connected" };
      }

      try {
        const message: OneBotMessage = [{ type: "text", data: { text } }];
        const success = await sendToTarget(client, to, message);
        return { channel: "qq", sent: success, error: success ? undefined : "Unknown target" };
      } catch (err) {
        console.error("[QQ] sendText error:", err);
        return { channel: "qq", sent: false, error: String(err) };
      }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
      if (!client) {
        return { channel: "qq", sent: false, error: "Client not connected" };
      }

      try {
        console.log("[QQ] sendMedia: to=" + to + ", url=" + mediaUrl.substring(0, 100));

        // 拒绝data URL
        if (mediaUrl.startsWith("data:")) {
          console.error("[QQ] Rejected data URL. Use HTTP URL or save to /home/node/clawd/ instead.");
          return {
            channel: "qq",
            sent: false,
            error: "Data URLs not supported. Please use HTTP URL or save file to /home/node/clawd/ directory and use file path."
          };
        }

        const mediaType = detectMediaType(mediaUrl);
        console.log("[QQ] Detected media type: " + mediaType + " for " + mediaUrl);

        // 如果没有文本，使用空字符串而不是undefined，避免OpenClaw发送额外的提示消息
        const messageText = text || "";

        if (mediaType === "image" || mediaType === "audio" || mediaType === "video") {
          const processedUrl = convertLocalPathToUrl(mediaUrl);
          const message: OneBotMessage = [];
          if (text) {
            message.push({ type: "text", data: { text } });
          }

          if (mediaType === "image") {
            message.push({ type: "image", data: { file: processedUrl } });
          } else if (mediaType === "audio") {
            message.push({ type: "record", data: { file: processedUrl } });
          } else if (mediaType === "video") {
            message.push({ type: "video", data: { file: processedUrl } });
          }

          const success = await sendToTarget(client, to, message);
          return { channel: "qq", sent: success };
        }

        // 其他文件类型用文件上传接口
        const fileName = path.basename(mediaUrl);
        const success = await sendFileToTarget(client, to, mediaUrl, fileName);

        if (success && text) {
          await sendToTarget(client, to, [{ type: "text", data: { text } }]);
        }

        return { channel: "qq", sent: success };
      } catch (err) {
        console.error("[QQ] sendMedia error:", err);
        return { channel: "qq", sent: false, error: String(err) };
      }
    }
  },
  messaging: {
    normalizeTarget: normalizeTarget,
    targetResolver: {
      looksLikeId: looksLikeQQTargetId,
      hint: "<QQ号> 或 group:<群号>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  }
};
