import { z } from "zod";

// ===== 唤醒配置 Schema =====
// 控制 Bot 在群聊中何时被唤醒并回复消息
// 支持多种触发方式，可通过 matchLogic 配置多条件的组合逻辑
const WakeupSchema = z.object({
  // 唤醒概率（0-100 的整数，表示百分比）
  // 默认 10 表示 10% 的概率随机回复群聊消息
  // 设为 0 则禁用随机唤醒，设为 100 则每条消息都触发随机唤醒
  probability: z.number().min(0).max(100).default(10)
    .describe("唤醒概率百分比，0-100，默认10表示10%"),
  // 是否始终回复私聊消息（不受唤醒条件和频率限制的约束）
  // 设为 true 时，私聊消息直接回复，跳过所有过滤逻辑
  alwaysReplyPrivate: z.boolean().default(true)
    .describe("是否始终回复私聊消息"),
  // 是否在被 @（at）时总是回复
  // 检查消息中的 CQ:at 段，判断是否 @ 了 Bot 自身
  replyOnAt: z.boolean().default(true)
    .describe("被@时是否总是回复"),
  // 触发唤醒的名字列表（不区分大小写）
  // 当消息文本中包含列表里的任一名字时，视为"提及名字"触发
  names: z.array(z.string()).default([])
    .describe("触发唤醒的名字列表，如 ['桃桃', '小桃']"),
  // 触发唤醒的关键词列表（不区分大小写）
  // 当消息文本中包含列表里的任一关键词时，视为"关键词"触发
  keywords: z.array(z.string()).default([])
    .describe("触发唤醒的关键词列表"),
  // 多条件生效逻辑，仅作用于 names、replyOnAt、keywords 三个显式触发条件
  // "or"：任一显式条件满足即触发（默认）
  // "and"：所有已配置的显式条件都满足才触发
  // 注意：随机概率（probability）是独立的回退机制，不参与 and/or 逻辑
  matchLogic: z.enum(["or", "and"]).default("or")
    .describe("显式触发条件的组合逻辑：or=任一满足，and=全部满足"),
}).optional();

// ===== 频率限制配置 Schema =====
// 控制 Bot 发送消息的最小时间间隔，防止短时间内连续发送消息
const RateLimitSchema = z.object({
  // 最小发送间隔，单位：秒
  // 两次发送消息之间至少间隔该秒数，期间收到的消息将被静默忽略
  // 设为 0 则不限制发送频率
  minInterval: z.number().min(0).default(10)
    .describe("最小发送间隔（秒），默认10秒"),
  // 是否按会话（群/私聊）独立计时
  // true：每个群、每个私聊各自独立计算时间间隔（推荐）
  // false：所有会话共享同一个时间间隔计时器（更严格的全局限制）
  perSession: z.boolean().default(true)
    .describe("是否按会话独立计时，true=每个群/私聊独立，false=全局统一"),
}).optional();

const GroupRuleSchema = z.object({
  groupId: z.number().describe("群号"),
  autoApprovePattern: z.string().optional().describe("该群的入群验证信息正则，匹配则自动同意"),
  welcomeMessage: z.string().optional().describe("该群的自定义欢迎语模板"),
  antiRecall: z.boolean().optional().describe("该群是否开启防撤回"),
});

export const QQConfigSchema = z.object({
  wsUrl: z.string().url().describe("The WebSocket URL of the OneBot v11 server (e.g. ws://localhost:3001)"),
  accessToken: z.string().optional().describe("The access token for the OneBot server"),
  admins: z.array(z.number()).optional().describe("List of admin QQ numbers"),

  // 主人QQ号，用于接收审核通知和控制指令
  ownerQQ: z.number().optional().describe("主人QQ号，接收审核通知和控制指令"),

  // 自动审核配置
  autoApprove: z.object({
    friend: z.object({
      enabled: z.boolean().default(false).describe("是否开启好友申请自动审核"),
      pattern: z.string().optional().describe("验证信息正则，匹配则自动同意"),
    }).optional(),
    group: z.object({
      enabled: z.boolean().default(false).describe("是否开启入群申请自动审核"),
      pattern: z.string().optional().describe("默认验证信息正则，匹配则自动同意"),
      rules: z.array(GroupRuleSchema).optional().describe("每个群的单独审核规则"),
    }).optional(),
  }).optional(),

  // 通知开关
  notifications: z.object({
    memberChange: z.boolean().default(true).describe("群成员变动通知"),
    antiRecall: z.boolean().default(true).describe("防撤回（撤回消息通知）"),
    adminChange: z.boolean().default(true).describe("群管理员变动通知"),
    banNotice: z.boolean().default(false).describe("禁言通知"),
    fileUpload: z.boolean().default(false).describe("群文件上传通知"),
    pokeReply: z.boolean().default(true).describe("被戳一戳时自动回复"),
    honorNotice: z.boolean().default(false).describe("群荣誉变更通知"),
  }).optional(),

  // 入群欢迎消息
  welcome: z.object({
    enabled: z.boolean().default(false).describe("是否开启入群欢迎消息"),
    template: z.string().default("欢迎 {nickname} 加入本群！").describe("欢迎语模板，{nickname}会被替换为昵称"),
  }).optional(),

  // 唤醒配置，控制 Bot 在群聊中的触发条件
  wakeup: WakeupSchema,
  // 频率限制配置，控制消息发送的最小时间间隔
  rateLimit: RateLimitSchema,
});

export type QQConfig = z.infer<typeof QQConfigSchema>;
