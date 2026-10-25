// 平台转接头接口（P0，PLAN-CROSSPLATFORM §P0）。
//
// anima 的**核心平台无关**：消化/记忆/人格/向量/情绪全在 DB 上跑，只认 situation_log 行、
// experiences 行，不认任何 AI agent 平台的专有字段。真正绑平台的只有薄薄一层"转接头"——三件事：
//   ① 读那家的会话记录（transcript）→ 中性条目
//   ② 把工具调用（改文件/读文件/跑命令）按那家的工具语汇 → 中性活动事件
//   ③ 识别 harness 塞进 transcript 的合成"假用户轮"（斜杠命令/后台通知/信封回吐）
//   ④ 剥掉注入回声（该平台 harness 注入 + anima 自注入），防"记忆里存着上次注入"的复读环
//
// 加一个新平台（Codex / Cursor / …）= 写一个新 Adapter 实现，核心一字不改。
//
// ⚠️ 本文件**只依赖类型**（type-only import），运行时无任何具体实现的引入——故任何核心文件都能
// 安全 `import type { Adapter }` / `import { isSyntheticTurn }` 而不会与 capture/transcript 形成
// 循环引用。具体实现在 adapters/claudeCode.ts；生产选型在 adapters/registry.ts（由编排根/入口引——
// digest 夜跑编排、worker 循环、hooks；纯消费核心 capture/selfReview 不引 registry，只收 Adapter 参数）。
import type { TranscriptEntry } from "./transcript";
import type { SituationInput } from "./situation";
import type { UserTurnVerdict } from "./authorship";

export interface Adapter {
  /** 平台标识（'claude-code' | 'codex' | …）；落库/诊断用。 */
  readonly name: string;

  /**
   * ① 读该平台 transcript 文件 → 中性条目流。坏行容忍跳过、文件不存在返空。
   * 产出的 TranscriptEntry 是**中性契约**：uuid=有序不透明 id（游标/水位线/切片只比序不解析）、
   * timestamp=可排序 canonical ISO-UTC（日界/窗口）、content=text/tool 块。各平台各自解析、填同一形。
   */
  parseTranscript(path: string): TranscriptEntry[];

  /**
   * ② 从中性条目提取客观活动事件（→ situation_log 的 SituationInput）。
   * **拥有该平台的工具语汇**：哪个工具名算改文件、哪个算跑命令、命令/编辑的 input 形态怎么读。
   * 产出的 kind 必须落在核心的活动白名单内（见 capture.TRANSCRIPT_ACTIVITY_KINDS）。
   */
  extractEvents(entries: TranscriptEntry[]): SituationInput[];

  /**
   * ③ 用户轮真伪三分（human / synthetic_confirmed / synthetic_suspect）。
   * **拥有该平台 harness 合成轮的识别**（元数据信号 + 文本形态兜底）。采集侧（落 kind）与素材侧
   * （整条跳过，见 isSyntheticTurn）共用这唯一判据。非 user 条目恒 'human'。
   */
  classifyUserTurn(entry: TranscriptEntry): UserTurnVerdict;

  /**
   * ④ 注入回声剥离：剥掉该平台 harness 注入的结构（system-reminder 等）+ anima 自己的注入包裹，
   * 防复读环与情绪自激。采集正文、素材对话都先过它。
   */
  stripEcho(text: string): string;
}

/**
 * "非真人轮"并集判据＝铁证 ∪ 嫌疑（classifyUserTurn != 'human'）。**素材侧**（selfReview.assembleMaterial）
 * 整条跳过用它：material 是派生的、宁缺勿污，嫌疑行也不进对话素材。非 user 条目一律 false。
 * 从 adapter 的三分裁决派生，保证采集/素材两侧共用同一平台判据。
 */
export function isSyntheticTurn(adapter: Adapter, entry: TranscriptEntry): boolean {
  return entry.type === "user" && adapter.classifyUserTurn(entry) !== "human";
}
