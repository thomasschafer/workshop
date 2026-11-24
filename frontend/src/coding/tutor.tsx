import type { Conversation } from "../hooks/useConversation";
import { DiscussView } from "../views/discuss";
import { Modal } from "../views/modal";

/** The tutor, for hints that don't give the problem away, over the step being worked on. */
export function TutorSheet({
  conversation,
  models,
  model,
  onModel,
  online,
  onClose,
}: {
  conversation: Conversation;
  models: string[];
  model: string;
  onModel: (model: string) => void;
  online: boolean;
  onClose: () => void;
}) {
  return (
    <Modal title="Tutor" onClose={onClose} shape="full">
      {online ? null : (
        <p class="banner offline" role="status">
          The tutor needs the server, which can't be reached. Your conversation is kept here.
        </p>
      )}
      <DiscussView
        turns={conversation.turns}
        models={models}
        model={model}
        thinking={conversation.thinking}
        partial={conversation.partial}
        error={conversation.error}
        unanswered={conversation.unanswered}
        draft={conversation.draft}
        onDraft={conversation.setDraft}
        onModel={onModel}
        onSend={(text) => void conversation.send(text)}
        onRetry={() => void conversation.retry()}
        onClear={conversation.clear}
        intro="Stuck? Ask for a hint. The tutor sees the problem, your plan and your code, and nudges you towards the next step without giving the solution away."
      />
    </Modal>
  );
}
