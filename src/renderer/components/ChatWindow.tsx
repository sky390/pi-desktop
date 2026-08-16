import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ExtensionQuestionnaireAnswer,
  ExtensionQuestionnaireQuestion,
  ExtensionUiRequest,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import {
  countToolCallBlocks,
  getDisplayableAssistantBlocks,
  isAssistantFailure,
  splitFinalAssistantBlocks,
} from "@/lib/message-display";
import { MessageView } from "./MessageView";
import { SessionProfiler } from "./SessionProfiler";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs, type ChatMinimapMessage } from "./ChatMinimap";
import { useAgentSession, type AgentPhase, type FileChangeItem, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useObservedElementHeight } from "@/hooks/useObservedElementHeight";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { MessageRenderKeyRegistry, type MessageRenderRole } from "@/lib/message-render-key";
import { buildToolMessageIndex } from "@/lib/tool-message-index";
import { useI18n } from "@/i18n";
import appIconUrl from "../../../build/icon.png";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (
    tree: SessionTreeNode[],
    activeLeafId: string | null,
    onLeafChange: (leafId: string | null) => void,
  ) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (
    usage: { percent: number | null; contextWindow: number; tokens: number | null } | null,
  ) => void;
  onFileChangesChange?: (changes: FileChangeItem[]) => void;
  onOpenFile?: (filePath: string) => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, fallback: string) => string): string {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    const running = t("runningTools", "Running");
    if (names.length === 0) return t("runningTool", "Running tool…");
    if (names.length === 1) return `${running} ${names[0]}…`;
    if (names.length <= 3) return `${running} ${names.join(", ")}…`;
    return `${running} ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`;
  }
  if (phase?.kind === "waiting_model") return t("waitingForModel", "Waiting for model…");
  if (phase?.kind === "running_command") return t("runningCommand", "Running command…");
  return t("thinking", "Thinking…");
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

function toMinimapMessage(message: AgentMessage | Partial<AgentMessage>): ChatMinimapMessage | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const content = message.content;
  if (message.role === "user") {
    const preview =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ")
          : "";
    return { role: "user", preview: preview.slice(0, 200), hasText: true };
  }
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
  const toolNames = blocks.flatMap((block) => (block.type === "toolCall" ? [block.toolName] : []));
  return {
    role: "assistant",
    preview: (text || toolNames.join(", ")).slice(0, 200),
    hasText: text.length > 0,
  };
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  if (isAssistantFailure(message as AssistantMessage)) return true;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some(
    (block) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0),
  );
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean; omitFailure?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  if (options.omitFailure) {
    next.stopReason = undefined;
    next.errorMessage = undefined;
  }
  return next;
}

type AssistantRenderParts = {
  processBlocks: AssistantContentBlock[];
  processMessage: AssistantMessage | null;
  answerMessage: AssistantMessage | null;
};

function getAssistantRenderParts(
  cache: WeakMap<AssistantMessage, AssistantRenderParts>,
  message: AssistantMessage,
): AssistantRenderParts {
  const existing = cache.get(message);
  if (existing) return existing;
  const split = splitFinalAssistantBlocks(message);
  const created: AssistantRenderParts = {
    processBlocks: split.processBlocks,
    processMessage:
      split.processBlocks.length > 0
        ? withAssistantBlocks(message, split.processBlocks, { omitUsage: true, omitFailure: true })
        : null,
    answerMessage:
      split.answerBlocks.length > 0
        ? withAssistantBlocks(message, split.answerBlocks)
        : isAssistantFailure(message)
          ? withAssistantBlocks(message, [])
          : null,
  };
  cache.set(message, created);
  return created;
}

function ProcessDetailsGroup({
  messageCount,
  toolCallCount,
  children,
}: {
  messageCount: number;
  toolCallCount: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const { language, t } = useI18n();
  const parts = [
    t("processDetails", "Process details"),
    language === "zh-CN"
      ? `${messageCount} ${t("messagesCount", "messages")}`
      : `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
  ];
  if (toolCallCount > 0) {
    parts.push(
      language === "zh-CN"
        ? `${toolCallCount} ${t("toolCallsCount", "tool calls")}`
        : `${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`,
    );
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={
          expanded
            ? t("collapseProcessDetails", "Collapse process details")
            : t("expandProcessDetails", "Expand process details")
        }
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

export function ChatWindow({
  session,
  newSessionCwd,
  onAgentEnd,
  onSessionCreated,
  onSessionForked,
  modelsRefreshKey,
  chatInputRef,
  onBranchDataChange,
  onSystemPromptChange,
  onSessionStatsChange,
  onSessionStatsPanelOpen,
  onContextUsageChange,
  onFileChangesChange,
  onOpenFile,
}: Props) {
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const messageRenderKeys = useRef(new MessageRenderKeyRegistry()).current;
  const assistantRenderParts = useRef(new WeakMap<AssistantMessage, AssistantRenderParts>()).current;

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  const {
    loading,
    error,
    messages,
    entryIds,
    streamState,
    agentRunning,
    modelNames,
    modelList,
    modelListError,
    modelCatalog,
    modelRefreshing,
    modelThinkingLevels,
    modelThinkingLevelMaps,
    toolPreset,
    thinkingLevel,
    retryInfo,
    contextUsage,
    forkingEntryId,
    isCompacting,
    compactError,
    compactResult,
    displayModel: displayModelValue,
    sessionStats,
    slashCommands,
    slashCommandsLoading,
    queuedMessages,
    hasOlder,
    loadingOlder,
    notices,
    dismissNotice,
    extensionDialog,
    extensionCustomUi,
    extensionQuestionnaire,
    extensionStatuses,
    extensionWidgets,
    fileChanges,
    respondToExtensionUi,
    respondToExtensionQuestionnaire,
    sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    messagesEndRef,
    liveContentEndRef,
    scrollContainerRef,
    lastUserMsgRef,
    handleSend,
    handleAbort,
    handleFork,
    handleNavigate,
    handleModelChange,
    refreshModels,
    cancelModelRefresh,
    handleCompact,
    handleSteer,
    handleFollowUp,
    handlePromptWithStreamingBehavior,
    handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange,
    handleThinkingLevelChange,
    loadSlashCommands,
    loadOlder,
    loadDeferredContent,
  } = useAgentSession({
    session,
    newSessionCwd,
    onAgentEnd: wrappedOnAgentEnd,
    onSessionCreated,
    onSessionForked,
    modelsRefreshKey,
    chatInputRef,
    onBranchDataChange,
    onSystemPromptChange,
    onSessionStatsPanelOpen,
  });

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
        sessionStats.sessionId,
        sessionStats.sessionFile ?? "",
        sessionStats.sessionName ?? "",
        sessionStats.userMessages,
        sessionStats.assistantMessages,
        sessionStats.toolCalls,
        sessionStats.toolResults,
        sessionStats.totalMessages,
        sessionStats.tokens.input,
        sessionStats.tokens.output,
        sessionStats.tokens.cacheRead,
        sessionStats.tokens.cacheWrite,
        sessionStats.tokens.total,
        sessionStats.cost ?? 0,
      ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(
    () => () => {
      onSessionStatsChange?.(null);
    },
    [onSessionStatsChange],
  );

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(
    () => () => {
      onContextUsageChange?.(null);
    },
    [onContextUsageChange],
  );

  // Push file change records up to AppShell for the right-hand Changes panel.
  const fileChangesRef = useRef(fileChanges);
  fileChangesRef.current = fileChanges;
  useEffect(() => {
    onFileChangesChange?.(fileChangesRef.current);
  }, [fileChanges, onFileChangesChange]);
  useEffect(
    () => () => {
      onFileChangesChange?.([]);
    },
    [onFileChangesChange],
  );

  const onDrop = useCallback(
    (files: File[]) => {
      if (agentRunning) return;
      chatInputRef?.current?.addImages(files);
    },
    [agentRunning, chatInputRef],
  );

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const messageRefs = useMessageRefs(visibleMessages.length);
  const minimapMessages = useMemo(() => messages.flatMap((message) => toMinimapMessage(message) ?? []), [messages]);
  const minimapStreamingMessage = useMemo(
    () => (streamState.streamingMessage ? toMinimapMessage(streamState.streamingMessage) : null),
    [streamState.streamingMessage],
  );
  const toolMessageIndex = useMemo(() => buildToolMessageIndex(messages), [messages]);
  const insertEditedContent = useCallback(
    (content: string) => chatInputRef?.current?.insertIfEmpty(content),
    [chatInputRef],
  );
  const olderHistorySentinelRef = useRef<HTMLDivElement | null>(null);
  const automaticHistoryPagesRef = useRef(0);

  useEffect(() => {
    automaticHistoryPagesRef.current = 0;
  }, [session?.id]);

  useEffect(() => {
    const sentinel = olderHistorySentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root || !hasOlder || loadingOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || automaticHistoryPagesRef.current >= 3) return;
        automaticHistoryPagesRef.current += 1;
        void loadOlder();
      },
      { root, rootMargin: "160px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasOlder, loadOlder, loadingOlder, messages.length, scrollContainerRef]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !agentRunning;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const chatViewportHeight = useObservedElementHeight(scrollContainerRef);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={agentRunning}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelListError={modelListError}
      modelCatalog={modelCatalog}
      modelRefreshing={modelRefreshing}
      onModelChange={handleModelChange}
      onModelsRefresh={refreshModels}
      onModelsRefreshCancel={cancelModelRefresh}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return <div className="flex h-full items-center justify-center text-text-muted">Loading session...</div>;
  }

  if (error) {
    return <div className="flex h-full items-center justify-center text-red-400">{error}</div>;
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Grid paper + corner ticks (design.html grid style) */}
      <div
        className={`chat-grid-bg${isEmptyNew ? " chat-grid-bg-idle" : ""} pointer-events-none absolute inset-0 z-0`}
        aria-hidden="true"
      />
      <div className="chat-corner-tick chat-corner-tick-tl" aria-hidden="true" />
      <div className="chat-corner-tick chat-corner-tick-tr" aria-hidden="true" />
      <div className="chat-corner-tick chat-corner-tick-bl" aria-hidden="true" />
      <div className="chat-corner-tick chat-corner-tick-br" aria-hidden="true" />

      {isDragOver && !agentRunning && (
        <div
          className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center backdrop-blur-[1px]"
          style={{ background: "color-mix(in srgb, var(--accent) 6%, transparent)" }}
        >
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{
                  transformOrigin: "center",
                  animationDelay: `${delay}s`,
                  borderColor: "color-mix(in srgb, var(--accent) 50%, transparent)",
                }}
              />
            ))}
          </div>
          <svg
            width="280"
            height="280"
            viewBox="0 0 140 140"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ filter: "drop-shadow(0 6px 18px color-mix(in srgb, var(--accent) 18%, transparent))" }}
          >
            <rect
              x="28"
              y="44"
              width="84"
              height="60"
              rx="8"
              fill="color-mix(in srgb, var(--accent) 8%, transparent)"
              stroke="color-mix(in srgb, var(--accent) 50%, transparent)"
              strokeWidth="1.8"
            />
            <path
              d="M36 100 L54 72 L68 88 L80 74 L104 100Z"
              fill="color-mix(in srgb, var(--accent) 16%, transparent)"
              stroke="color-mix(in srgb, var(--accent) 40%, transparent)"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <circle
              cx="96"
              cy="58"
              r="8"
              fill="color-mix(in srgb, var(--accent) 22%, transparent)"
              stroke="color-mix(in srgb, var(--accent) 55%, transparent)"
              strokeWidth="1.6"
            />
            <g stroke="color-mix(in srgb, var(--accent) 45%, transparent)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43" />
              <line x1="96" y1="70" x2="96" y2="73" />
              <line x1="84" y1="58" x2="81" y2="58" />
              <line x1="108" y1="58" x2="111" y2="58" />
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4" />
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6" />
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4" />
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6" />
            </g>
          </svg>
        </div>
      )}

      {extensionDialog && <ExtensionDialog request={extensionDialog} onRespond={respondToExtensionUi} />}

      {extensionQuestionnaire && (
        <QuestionnaireDialog request={extensionQuestionnaire} onRespond={respondToExtensionQuestionnaire} />
      )}

      {extensionCustomUi && <ExtensionCustomPanel request={extensionCustomUi} onInput={sendExtensionCustomInput} />}

      {isEmptyNew ? (
        <div className="relative z-[1] flex min-h-0 flex-[1_1_0] flex-col items-center justify-end overflow-y-auto px-4 pt-8">
          <div className="w-full" style={{ maxWidth: "var(--chat-content-max-width)" }}>
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginLeft: 16,
                marginRight: 52,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  lineHeight: 1.4,
                }}
              >
                <img
                  src={appIconUrl}
                  alt=""
                  aria-hidden="true"
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: "contain",
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 30,
                    color: "var(--text)",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  Pi Agent Desktop
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" onDismiss={dismissNotice} />
          </div>
        </div>
      ) : (
        <>
          <div className="chat-conversation-enter relative z-[1] flex min-h-0 flex-[1_1_0] overflow-hidden">
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 0,
                right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
                zIndex: 40,
                padding: `0 ${CHAT_COLUMN_PADDING}px`,
                pointerEvents: "none",
              }}
            >
              <div style={{ maxWidth: "var(--chat-content-max-width)", margin: "0 auto" }}>
                <NoticeShelf notices={notices} floating align="right" onDismiss={dismissNotice} />
              </div>
            </div>
            <div ref={scrollContainerRef} className="relative z-[1] flex-1 overflow-y-auto pt-4 [scrollbar-width:none]">
              <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
                <div style={{ maxWidth: "var(--chat-content-max-width)", margin: "0 auto" }}>
                  {(hasOlder || loadingOlder) && (
                    <div
                      ref={olderHistorySentinelRef}
                      style={{ display: "flex", justifyContent: "center", padding: 8 }}
                    >
                      <button
                        type="button"
                        disabled={loadingOlder}
                        onClick={() => void loadOlder()}
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: 7,
                          background: "var(--bg-panel)",
                          color: "var(--text-muted)",
                          cursor: loadingOlder ? "default" : "pointer",
                          fontSize: 11,
                          padding: "5px 10px",
                        }}
                      >
                        {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
                      </button>
                    </div>
                  )}
                  <ExtensionStatusBar statuses={extensionStatuses} />

                  {(() => {
                    let lastUserIdx = -1;
                    for (let i = messages.length - 1; i >= 0; i--) {
                      if (messages[i].role === "user") {
                        lastUserIdx = i;
                        break;
                      }
                    }

                    const timestampAssistantIndices = new Set<number>();
                    let foundAssistantInTurn = false;
                    for (let i = messages.length - 1; i >= 0; i--) {
                      if (messages[i].role === "user") {
                        foundAssistantInTurn = false;
                      } else if (messages[i].role === "assistant" && !foundAssistantInTurn) {
                        timestampAssistantIndices.add(i);
                        foundAssistantInTurn = true;
                      }
                    }

                    const visibleRefIndexByMessage = new Map<number, number>();
                    let refIdx = 0;
                    messages.forEach((msg, idx) => {
                      if (msg.role === "user" || msg.role === "assistant") {
                        visibleRefIndexByMessage.set(idx, refIdx++);
                      }
                    });

                    const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                      messageRefs.current[refIndex] = el;
                      if (idx === lastUserIdx) {
                        (lastUserMsgRef as { current: HTMLDivElement | null }).current = el;
                      }
                    };

                    const renderMessage = (
                      idx: number,
                      options: {
                        attachRef?: boolean;
                        renderRole?: MessageRenderRole;
                        messageOverride?: AgentMessage;
                        showTimestamp?: boolean;
                      } = {},
                    ): ReactNode => {
                      const msg = options.messageOverride ?? messages[idx];
                      const prevAssistantEntryId =
                        msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                          ? entryIds[idx - 1]
                          : undefined;
                      const isVisible = msg.role === "user" || msg.role === "assistant";
                      const currentRefIdx = visibleRefIndexByMessage.get(idx);
                      const renderRole = options.renderRole ?? "message";
                      const renderKey = messageRenderKeys.keyFor(messages[idx], entryIds[idx], renderRole);
                      const toolData = toolMessageIndex.get(messages[idx]);
                      let showTimestamp = false;
                      if (msg.role === "assistant") {
                        showTimestamp = timestampAssistantIndices.has(idx);
                        // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                        if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                          showTimestamp = false;
                        }
                      }
                      if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                      const view = (
                        <SessionProfiler key={renderKey} id="MessageView">
                          <MessageView
                            message={msg}
                            toolResults={toolData?.results}
                            toolCallDurations={toolData?.durations}
                            modelNames={modelNames}
                            cwd={messageCwd}
                            onOpenFile={onOpenFile}
                            entryId={entryIds[idx]}
                            onFork={
                              agentRunning || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork
                            }
                            forking={forkingEntryId === entryIds[idx]}
                            onNavigate={agentRunning ? undefined : handleNavigate}
                            prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
                            onEditContent={insertEditedContent}
                            onLoadDeferredContent={loadDeferredContent}
                            showTimestamp={showTimestamp}
                            prevTimestamp={
                              idx > 0
                                ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp
                                : undefined
                            }
                          />
                        </SessionProfiler>
                      );
                      if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
                      return (
                        <div key={renderKey} ref={attachVisibleRef(idx, currentRefIdx)}>
                          {view}
                        </div>
                      );
                    };

                    const rendered: ReactNode[] = [];
                    for (let idx = 0; idx < messages.length;) {
                      const msg = messages[idx];
                      if (msg.role !== "user") {
                        rendered.push(renderMessage(idx));
                        idx += 1;
                        continue;
                      }

                      const userIdx = idx;
                      let endIdx = userIdx + 1;
                      while (endIdx < messages.length && messages[endIdx].role !== "user") endIdx += 1;

                      const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                      if (finalAssistantIdx === -1) {
                        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                          rendered.push(renderMessage(renderIdx));
                        }
                        idx = endIdx;
                        continue;
                      }

                      const isLiveTail =
                        (agentRunning || streamState.isStreaming) &&
                        endIdx === messages.length &&
                        userIdx === lastUserIdx;
                      if (isLiveTail) {
                        for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                          rendered.push(renderMessage(renderIdx));
                        }
                        idx = endIdx;
                        continue;
                      }

                      rendered.push(renderMessage(userIdx));

                      const processIndices: number[] = [];
                      for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                        processIndices.push(processIdx);
                      }
                      const visibleProcessIndices = processIndices.filter((processIdx) =>
                        hasDisplayableProcessMessage(messages[processIdx]),
                      );
                      const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                      const finalParts = getAssistantRenderParts(assistantRenderParts, finalAssistant);
                      const finalProcessMessage = finalParts.processMessage;
                      const finalAnswerMessage = finalParts.answerMessage;

                      const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
                      if (processCount > 0) {
                        const processRefIdx =
                          visibleProcessIndices
                            .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
                            .find((value): value is number => typeof value === "number") ??
                          (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
                        const processGroup = (
                          <ProcessDetailsGroup
                            messageCount={processCount}
                            toolCallCount={
                              countToolCalls(messages, visibleProcessIndices) +
                              countToolCallBlocks(finalParts.processBlocks)
                            }
                          >
                            {visibleProcessIndices.map((processIdx) =>
                              renderMessage(processIdx, { attachRef: false, renderRole: "process" }),
                            )}
                            {finalProcessMessage &&
                              renderMessage(finalAssistantIdx, {
                                attachRef: false,
                                renderRole: "process-final",
                                messageOverride: finalProcessMessage,
                                showTimestamp: false,
                              })}
                          </ProcessDetailsGroup>
                        );
                        rendered.push(
                          <div
                            key={`process-group:${messageRenderKeys.keyFor(
                              messages[userIdx],
                              entryIds[userIdx],
                              "message",
                            )}:${messageRenderKeys.keyFor(
                              messages[finalAssistantIdx],
                              entryIds[finalAssistantIdx],
                              "final",
                            )}`}
                            ref={
                              processRefIdx === undefined
                                ? undefined
                                : (el) => {
                                    messageRefs.current[processRefIdx] = el;
                                  }
                            }
                          >
                            {processGroup}
                          </div>,
                        );
                      }

                      if (finalAnswerMessage) {
                        rendered.push(
                          renderMessage(finalAssistantIdx, {
                            renderRole: "final",
                            messageOverride: finalAnswerMessage,
                          }),
                        );
                      }
                      for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                        rendered.push(renderMessage(renderIdx));
                      }
                      idx = endIdx;
                    }
                    return rendered;
                  })()}

                  {streamState.isStreaming && streamState.streamingMessage && (
                    <SessionProfiler id="MessageView">
                      <MessageView
                        message={streamState.streamingMessage as AgentMessage}
                        isStreaming
                        modelNames={modelNames}
                        cwd={messageCwd}
                        onOpenFile={onOpenFile}
                      />
                    </SessionProfiler>
                  )}

                  {agentRunning && !streamState.streamingMessage && (
                    <div className="py-2 text-[13px] text-text-muted">
                      <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
                    </div>
                  )}

                  <div ref={liveContentEndRef} />

                  {agentRunning && <div style={{ height: chatViewportHeight }} />}

                  <div ref={messagesEndRef} />
                </div>
              </div>
            </div>
            {isMobile ? null : (
              <SessionProfiler id="ChatMinimap">
                <ChatMinimap
                  messages={minimapMessages}
                  streamingMessage={minimapStreamingMessage}
                  scrollContainer={scrollContainerRef}
                  messageRefs={messageRefs}
                  historyTruncated={hasOlder}
                />
              </SessionProfiler>
            )}
          </div>
        </>
      )}

      <div
        className="chat-input-transition-dock relative z-[2] w-full flex-shrink-0 self-center"
        style={{ maxWidth: "var(--chat-content-max-width)" }}
        data-position={isEmptyNew ? "welcome" : "conversation"}
      >
        {!isEmptyNew && aboveEditorWidgets.length > 0 && (
          <div
            style={{
              padding: `0 ${CHAT_COLUMN_PADDING}px`,
              paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
            }}
          >
            <ExtensionWidgets widgets={aboveEditorWidgets} />
          </div>
        )}
        {!isEmptyNew && belowEditorWidgets.length > 0 && (
          <div
            style={{
              padding: `0 ${CHAT_COLUMN_PADDING}px`,
              paddingRight: isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
            }}
          >
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        )}
        {chatInputElement}
      </div>

      <div className="chat-input-bottom-spacer" data-expanded={isEmptyNew ? "true" : "false"} aria-hidden="true" />
    </div>
  );
}

function ExtensionStatusBar({ statuses }: { statuses: Array<{ key: string; text: string }> }) {
  if (statuses.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      {statuses.map((status) => (
        <div
          key={status.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            maxWidth: "100%",
            padding: "4px 8px",
            border: "1px solid color-mix(in srgb, var(--accent) 24%, var(--border))",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--accent) 7%, var(--bg))",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{status.key}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (widgets.length === 0) return null;
  const toggleCollapsed = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => {
        // An extension widget that renders no lines (e.g. the todo overlay after
        // the previous turn's completed tasks are hidden) has no content to show —
        // skip the whole box instead of leaving an empty title bar on screen.
        if (widget.lines.length === 0) return null;
        const isCollapsed = collapsed[widget.key] === true;
        const displayLines = isCollapsed ? widget.lines.slice(0, 1) : widget.lines;
        return (
          <div
            key={widget.key}
            style={{
              width: "100%",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-panel)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "5px 9px",
                borderBottom: "1px solid var(--border)",
                color: "var(--text-dim)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {widget.key}
              </span>
              <button
                type="button"
                title={isCollapsed ? "Expand" : "Collapse"}
                aria-label={isCollapsed ? "Expand" : "Collapse"}
                onClick={() => toggleCollapsed(widget.key)}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 11,
                  flexShrink: 0,
                }}
              >
                {isCollapsed ? "＋" : "－"}
              </button>
            </div>
            {displayLines.length > 0 && (
              <pre
                style={{
                  margin: 0,
                  padding: "8px 9px",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {displayLines.join("\n")}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NoticeShelf({
  notices,
  floating = false,
  align = "left",
  onDismiss,
}: {
  notices: NoticeItem[];
  floating?: boolean;
  align?: "left" | "right";
  onDismiss?: (id: string) => void;
}) {
  if (notices.length === 0) return null;
  // Map rpiv-todo's status glyphs (○/◐/✓) to emoji, mirroring the widget
  // theme mapping in rpc-manager.ts so /todos output matches the panel.
  const mapStatusIcons = (text: string) =>
    text
      .replaceAll("○", "⏳") // pending
      .replaceAll("◐", "🧠") // in_progress
      .replaceAll("✓", "✨"); // completed
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
        pointerEvents: "auto",
      }}
    >
      {notices.map((notice, index) => {
        const color =
          notice.type === "error"
            ? "#ef4444"
            : notice.type === "warning"
              ? "#d97706"
              : notice.type === "success"
                ? "#10b981"
                : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              minHeight: 40,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflowY: "auto",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 13,
              lineHeight: 1.5,
              maxHeight: "min(60vh, 520px)",
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align the dot with the center of the first text line
                // (9px padding-top + 13px * 1.5 / 2 - 3.5px dot radius).
                marginTop: 15,
              }}
            />
            <span
              style={{
                padding: "9px 0",
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {mapStatusIcons(notice.message)}
            </span>
            {onDismiss && (
              <button
                type="button"
                title="Dismiss"
                aria-label="Dismiss"
                onClick={() => onDismiss(notice.id)}
                style={{
                  alignSelf: "flex-start",
                  marginTop: 8,
                  padding: "2px 6px",
                  borderRadius: 6,
                  border: "none",
                  background: "transparent",
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 13,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                {"×"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (
    request: ExtensionDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => void;
}) {
  const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");

  useEffect(() => {
    setValue(request.method === "editor" ? (request.prefill ?? "") : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            extension request
          </div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {request.message}
            </div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Confirm
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Submit
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type QuestionnaireDialogRequest = Extract<ExtensionUiRequest, { method: "questionnaire" }>;

type QuestionDraft = {
  optionIndex: number | null;
  checked: number[];
  custom: string;
  notes: string;
};

function answerSummary(q: ExtensionQuestionnaireQuestion, d: QuestionDraft): string {
  if (d.custom.trim() !== "") return d.custom.trim();
  if (q.multiSelect) return d.checked.map((idx) => q.options[idx].label).join(", ");
  if (d.optionIndex !== null) return q.options[d.optionIndex].label;
  return "";
}

function isQuestionAnswered(q: ExtensionQuestionnaireQuestion, d: QuestionDraft): boolean {
  if (d.custom.trim() !== "") return true;
  return q.multiSelect ? d.checked.length > 0 : d.optionIndex !== null;
}

/**
 * Full-questionnaire dialog for `ask_user_question` in Pi Desktop.
 *
 * Replicates the rpiv-ask-user-question TUI semantics for desktop: per-question
 * tabs plus a Submit review tab (multi-question runs), single/multi select,
 * side-by-side previews, the "Type something." custom-answer escape, per-question
 * notes, and Esc to abandon the whole questionnaire (cancelled). The produced
 * `ExtensionQuestionnaireAnswer[]` mirrors `QuestionAnswer` in the extension.
 */
function QuestionnaireDialog({
  request,
  onRespond,
}: {
  request: QuestionnaireDialogRequest;
  onRespond: (
    request: QuestionnaireDialogRequest,
    response: { answers: ExtensionQuestionnaireAnswer[]; cancelled: boolean },
  ) => void;
}) {
  const { questions } = request;
  const isMulti = questions.length > 1;
  const [tab, setTab] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    questions.map(() => ({ optionIndex: null, checked: [], custom: "", notes: "" })),
  );
  const [notesOpen, setNotesOpen] = useState<boolean[]>(() => questions.map(() => false));

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (collapsed) {
        // While minimized, Esc re-expands instead of abandoning the questionnaire.
        e.preventDefault();
        setCollapsed(false);
        return;
      }
      onRespond(request, { answers: [], cancelled: true });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request, onRespond, collapsed]);

  const updateDraft = (index: number, patch: Partial<QuestionDraft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const buildAnswers = (): ExtensionQuestionnaireAnswer[] => {
    const out: ExtensionQuestionnaireAnswer[] = [];
    questions.forEach((q, i) => {
      const d = drafts[i];
      const notes = d.notes.trim() || undefined;
      if (d.custom.trim() !== "") {
        out.push({ questionIndex: i, question: q.question, kind: "custom", answer: d.custom.trim(), notes });
      } else if (q.multiSelect) {
        if (d.checked.length > 0) {
          out.push({
            questionIndex: i,
            question: q.question,
            kind: "multi",
            answer: null,
            selected: d.checked.map((idx) => q.options[idx].label),
            notes,
          });
        }
      } else if (d.optionIndex !== null) {
        const o = q.options[d.optionIndex];
        out.push({
          questionIndex: i,
          question: q.question,
          kind: "option",
          answer: o.label,
          preview: o.preview && o.preview.length > 0 ? o.preview : undefined,
          notes,
        });
      }
    });
    return out;
  };

  const submit = () => onRespond(request, { answers: buildAnswers(), cancelled: false });
  const cancel = () => onRespond(request, { answers: [], cancelled: true });
  const unansweredCount = questions.filter((_, i) => !isQuestionAnswered(questions[i], drafts[i])).length;

  const q = tab < questions.length ? questions[tab] : null;
  const d = q ? drafts[tab] : null;
  const selectedOption = q && d && !q.multiSelect && d.optionIndex !== null ? q.options[d.optionIndex] : null;

  if (collapsed) {
    const answeredCount = questions.filter((_, i) => isQuestionAnswered(questions[i], drafts[i])).length;
    return (
      <button
        onClick={() => setCollapsed(false)}
        aria-label="Expand questionnaire"
        title="Expand questionnaire"
        style={{
          position: "absolute",
          zIndex: 90,
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: "1px solid var(--border)",
          borderRadius: 999,
          background: "var(--bg)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          color: "var(--text)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 13 }}>📋</span>
        <span style={{ fontWeight: 650 }}>Questionnaire</span>
        <span
          style={{
            color: answeredCount > 0 ? "var(--accent)" : "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          {answeredCount}/{questions.length} answered
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>▾</span>
      </button>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(780px, 100%)",
          maxHeight: "min(80vh, 640px)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>Questionnaire</div>
            <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              ask_user_question · {questions.length} question{questions.length > 1 ? "s" : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              onClick={() => setCollapsed(true)}
              aria-label="Minimize questionnaire"
              title="Minimize questionnaire (answers are kept)"
              style={{
                border: "none",
                background: "none",
                color: "var(--text-muted)",
                fontSize: 18,
                cursor: "pointer",
                padding: "2px 8px",
                borderRadius: 6,
              }}
            >
              −
            </button>
            <button
              onClick={cancel}
              aria-label="Close questionnaire"
              style={{
                border: "none",
                background: "none",
                color: "var(--text-muted)",
                fontSize: 18,
                cursor: "pointer",
                padding: "2px 8px",
                borderRadius: 6,
              }}
            >
              ×
            </button>
          </div>
        </div>

        {isMulti && (
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: "8px 14px 0",
              borderBottom: "1px solid var(--border)",
              overflowX: "auto",
            }}
          >
            {questions.map((question, i) => {
              const answered = isQuestionAnswered(question, drafts[i]);
              const active = tab === i;
              return (
                <button
                  key={i}
                  onClick={() => setTab(i)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: "6px 6px 0 0",
                    border: "1px solid transparent",
                    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                    background: active ? "var(--bg-panel)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {answered ? "✓ " : ""}
                  {question.header || `Q${i + 1}`}
                </button>
              );
            })}
            <button
              onClick={() => setTab(questions.length)}
              style={{
                padding: "6px 10px",
                borderRadius: "6px 6px 0 0",
                border: "1px solid transparent",
                borderBottom: tab === questions.length ? "2px solid var(--accent)" : "2px solid transparent",
                background: tab === questions.length ? "var(--bg-panel)" : "transparent",
                color: tab === questions.length ? "var(--text)" : "var(--text-muted)",
                fontSize: 12,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Submit{unansweredCount > 0 ? ` (${unansweredCount} unanswered)` : ""}
            </button>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {q && d ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 600, lineHeight: 1.45 }}>
                  {q.header ? (
                    <span
                      style={{
                        display: "inline-block",
                        marginRight: 8,
                        padding: "2px 7px",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        color: "var(--text-muted)",
                        fontSize: 11,
                        verticalAlign: "middle",
                      }}
                    >
                      {q.header}
                    </span>
                  ) : null}
                  {q.question}
                </div>
                <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>
                  {q.multiSelect ? "Select all that apply." : "Choose one."}
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: selectedOption?.preview ? "1fr 260px" : "1fr",
                  gap: 12,
                  alignItems: "start",
                }}
              >
                <div style={{ display: "grid", gap: 8 }}>
                  {q.options.map((o, oi) => {
                    const isSel = q.multiSelect ? d.checked.includes(oi) : d.optionIndex === oi;
                    return (
                      <button
                        key={oi}
                        onClick={() => {
                          if (q.multiSelect) {
                            updateDraft(tab, {
                              checked: d.checked.includes(oi) ? d.checked.filter((x) => x !== oi) : [...d.checked, oi],
                            });
                          } else {
                            updateDraft(tab, { optionIndex: d.optionIndex === oi ? null : oi });
                          }
                        }}
                        style={{
                          width: "100%",
                          padding: "9px 10px",
                          borderRadius: 7,
                          border: isSel ? "1px solid var(--accent)" : "1px solid var(--border)",
                          background: isSel ? "var(--bg-panel)" : "var(--bg-panel)",
                          color: "var(--text)",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 13,
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <span style={{ color: isSel ? "var(--accent)" : "var(--text-muted)", fontSize: 13 }}>
                            {q.multiSelect ? (isSel ? "☑" : "☐") : isSel ? "●" : "○"}
                          </span>
                          <span>
                            <span style={{ fontWeight: 600 }}>{o.label}</span>
                            <span style={{ color: "var(--text-muted)" }}> — {o.description}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}

                  <div
                    style={{
                      padding: "9px 10px",
                      borderRadius: 7,
                      border: "1px dashed var(--border)",
                      background: "var(--bg-panel)",
                    }}
                  >
                    <textarea
                      value={d.custom}
                      placeholder="Type something."
                      onChange={(e) => updateDraft(tab, { custom: e.target.value })}
                      rows={Math.min(4, Math.max(2, d.custom.split("\n").length))}
                      style={{
                        width: "100%",
                        border: "none",
                        background: "transparent",
                        color: "var(--text)",
                        outline: "none",
                        resize: "vertical",
                        fontSize: 13,
                        lineHeight: 1.5,
                        fontFamily: "inherit",
                      }}
                    />
                  </div>

                  {notesOpen[tab] ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      <textarea
                        autoFocus
                        value={d.notes}
                        placeholder="Note to attach to this answer…"
                        onChange={(e) => updateDraft(tab, { notes: e.target.value })}
                        rows={3}
                        style={{
                          width: "100%",
                          padding: "8px 10px",
                          borderRadius: 7,
                          border: "1px solid var(--border)",
                          background: "var(--bg)",
                          color: "var(--text)",
                          outline: "none",
                          resize: "vertical",
                          fontSize: 12,
                          lineHeight: 1.5,
                          fontFamily: "inherit",
                        }}
                      />
                      <button
                        onClick={() => setNotesOpen((prev) => prev.map((v, i) => (i === tab ? false : v)))}
                        style={{
                          justifySelf: "start",
                          padding: "3px 8px",
                          borderRadius: 5,
                          border: "1px solid var(--border)",
                          background: "var(--bg)",
                          color: "var(--text-muted)",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        Done
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setNotesOpen((prev) => prev.map((v, i) => (i === tab ? true : v)))}
                      style={{
                        justifySelf: "start",
                        padding: "3px 8px",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        background: "var(--bg)",
                        color: "var(--text-muted)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {d.notes.trim() ? "Edit note" : "Add note"}
                    </button>
                  )}
                </div>

                {selectedOption?.preview && (
                  <div
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      padding: 10,
                      background: "var(--bg-panel)",
                      overflow: "auto",
                      maxHeight: 280,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-dim)",
                        marginBottom: 6,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      Preview
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: "var(--text)",
                      }}
                    >
                      {selectedOption.preview}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>Review your answers</div>
              {questions.map((question, i) => {
                const answered = isQuestionAnswered(question, drafts[i]);
                return (
                  <div
                    key={i}
                    style={{
                      padding: 10,
                      borderRadius: 7,
                      border: "1px solid var(--border)",
                      background: "var(--bg-panel)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                      <span style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.45 }}>
                        {question.header ? `${question.header}. ` : `Q${i + 1}. `}
                        {question.question}
                      </span>
                      {answered ? (
                        <span style={{ color: "#2ecc71", fontSize: 12, whiteSpace: "nowrap" }}>✓ answered</span>
                      ) : (
                        <span style={{ color: "#e5a50a", fontSize: 12, whiteSpace: "nowrap" }}>unanswered</span>
                      )}
                    </div>
                    {answered && (
                      <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
                        {answerSummary(question, drafts[i])}
                      </div>
                    )}
                    {!answered && (
                      <button
                        onClick={() => setTab(i)}
                        style={{
                          marginTop: 6,
                          padding: "3px 8px",
                          borderRadius: 5,
                          border: "1px solid var(--border)",
                          background: "var(--bg)",
                          color: "var(--accent)",
                          fontSize: 11,
                          cursor: "pointer",
                        }}
                      >
                        Answer now
                      </button>
                    )}
                  </div>
                );
              })}
              {unansweredCount > 0 && (
                <div style={{ color: "#e5a50a", fontSize: 12 }}>
                  {unansweredCount} question{unansweredCount > 1 ? "s" : ""} still unanswered — you can submit anyway.
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <button
            onClick={cancel}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Cancel (Esc)
          </button>
          {isMulti ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setTab(Math.max(0, tab - 1))}
                disabled={tab === 0}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  cursor: tab === 0 ? "default" : "pointer",
                  opacity: tab === 0 ? 0.5 : 1,
                }}
              >
                Back
              </button>
              {tab < questions.length - 1 ? (
                <button
                  onClick={() => setTab(tab + 1)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--accent)",
                    background: "var(--accent)",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Next
                </button>
              ) : tab === questions.length ? (
                <button
                  onClick={submit}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--accent)",
                    background: "var(--accent)",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Submit answers
                </button>
              ) : (
                <button
                  onClick={() => setTab(questions.length)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--accent)",
                    background: "var(--accent)",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Review
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={submit}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Submit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function toTerminalKeyData(e: KeyboardEvent): string | null {
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
    const ch = e.key.toLowerCase();
    if (ch >= "a" && ch <= "z") {
      return String.fromCharCode(ch.charCodeAt(0) - 96);
    }
  }

  switch (e.key) {
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Enter":
      return "\r";
    case "Escape":
      return "\x1b";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case " ":
      return " ";
    default:
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) return e.key;
      return null;
  }
}

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) =>
    Object.keys(segment.style).length > 0 ? (
      <span key={`${keyPrefix}-${index}`} style={segment.style}>
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  );
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    panelRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        ref={panelRef}
        tabIndex={0}
        role="dialog"
        aria-modal="true"
        onKeyDown={(e) => {
          const data = toTerminalKeyData(e);
          if (!data) return;
          e.preventDefault();
          e.stopPropagation();
          onInput(request, data);
        }}
        style={{
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>Extension panel</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Close
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
