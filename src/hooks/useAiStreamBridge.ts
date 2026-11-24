import { useEffect, useRef } from "react";
import { AiStreamBuffer } from "../ai-stream-buffer";
import type { AiStreamPayload } from "../tauri-protocol";
import type { AiMessage } from "./useAiConversations";

export type AiStreamListener = (
  callback: (payload: AiStreamPayload) => void,
) => Promise<() => void>;

interface UseAiStreamBridgeOptions {
  listenToStream: AiStreamListener;
  updateMessages: (
    hostId: string,
    conversationId: string,
    update: (messages: AiMessage[]) => AiMessage[],
  ) => unknown;
}

/** Coalesces backend stream deltas into the assistant message being generated. */
export function useAiStreamBridge({ listenToStream, updateMessages }: UseAiStreamBridgeOptions) {
  const updateMessagesRef = useRef(updateMessages);
  updateMessagesRef.current = updateMessages;
  const streamBufferRef = useRef<AiStreamBuffer>();
  streamBufferRef.current ??= new AiStreamBuffer((target, chunk) =>
    updateMessagesRef.current(target.hostId, target.conversationId, (current) =>
      current.map((message) =>
        message.id === target.assistantId
          ? {
              ...message,
              content: message.content + chunk.content,
              ...(chunk.reasoning
                ? { reasoning: `${message.reasoning ?? ""}${chunk.reasoning}` }
                : {}),
            }
          : message,
      ),
    ),
  );
  const streamBuffer = streamBufferRef.current;

  useEffect(() => {
    let disposed = false;
    let stopStream: (() => void) | undefined;
    void listenToStream((payload) => {
      streamBuffer.push(
        payload.requestId,
        payload.kind === "reasoning" ? "reasoning" : "content",
        payload.delta,
      );
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopStream = unlisten;
    });
    return () => {
      disposed = true;
      stopStream?.();
    };
  }, [listenToStream, streamBuffer]);

  return { streamBuffer };
}
