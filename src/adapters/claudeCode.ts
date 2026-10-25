// Claude Code 转接头（P0）：Adapter 接口的第一个实现，也是至今唯一在生产跑的实现。
//
// 它**不含新逻辑**——只是把早已存在、久经对抗审查的四个 Claude Code 专有函数捆成一个 Adapter：
//   parseTranscript   ← transcript.readTranscriptEntries（CC JSONL 解析）
//   extractEvents     ← capture.extractEvents（CC 工具语汇 Edit/Write/Bash/Read → 中性活动）
//   classifyUserTurn  ← authorship.classifyUserTurn（CC harness 合成轮识别）
//   stripEcho         ← echo.stripEcho（CC system-reminder 等注入回声剥离）
//
// 核心（capture/selfReview/digest/worker）不再直接 import 这些函数，改成"收下一个 Adapter"——
// 缺省仍走这四个函数（等价、零行为变化），显式传入别的 Adapter 即切平台。加 Codex/Cursor =
// 照本文件再写一个实现，核心一字不改。
import type { Adapter } from "../adapter";
import { readTranscriptEntries } from "../transcript";
import { extractEvents } from "../capture";
import { classifyUserTurn } from "../authorship";
import { stripEcho } from "../echo";

export const claudeCodeAdapter: Adapter = {
  name: "claude-code",
  parseTranscript: readTranscriptEntries,
  extractEvents,
  classifyUserTurn,
  stripEcho,
};
