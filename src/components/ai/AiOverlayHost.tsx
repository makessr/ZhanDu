import type { ComponentProps } from "react";
import AiConversationHistoryDrawer from "../AiConversationHistoryDrawer";
import AiFileChangeReviewModals from "../AiFileChangeReviewModals";

interface AiOverlayHostProps {
  historyDrawer: ComponentProps<typeof AiConversationHistoryDrawer>;
  fileChangeReview: ComponentProps<typeof AiFileChangeReviewModals>;
}

export default function AiOverlayHost({ historyDrawer, fileChangeReview }: AiOverlayHostProps) {
  return (
    <>
      <AiFileChangeReviewModals {...fileChangeReview} />
      <AiConversationHistoryDrawer {...historyDrawer} />
    </>
  );
}
