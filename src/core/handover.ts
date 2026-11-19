// The member handover package (docs/cluster-members.md「交接包」): what the next conversation needs to take over.
// Every line comes from records the Hub already has — no model call, no reading a harness's local files. Anything the
// records do not have stays null so the page can say 未知; nothing here is inferred.
import type { TaskStatus } from './collaboration-types.ts';
import type { MemberTaskFacts } from './plugin.ts';
import type { Cluster, Delivery, DeliveryResult, DeliveryState, Member, Message } from './types.ts';

/** Limits that keep the package readable and small enough to send as one group message. */
export const HANDOVER = {
  requests: 5, requestChars: 400,
  tasks: 10, summaryChars: 400, reasonChars: 600, questionChars: 200,
  deliveries: 5, errorChars: 200, messageChars: 120,
};

/** One line of a body: whitespace collapsed, then cut to `max` characters with an ellipsis. */
const excerpt = (text: string, max: number): string => {
  const oneLine = text.trim().replace(/\s+/g, ' ');
  // toWellFormed keeps a cut from splitting a surrogate pair (an emoji at the boundary would otherwise be broken).
  return oneLine.length > max ? `${oneLine.slice(0, max).toWellFormed()}…` : oneLine;
};

export interface HandoverPackage {
  member: { id: string; name: string; harness: string; model: string | null; cwd: string; sessionId: string };
  cluster: { id: string; name: string };
  generatedAt: string;
  /** The user's recent requests in the cluster, oldest first (their own messages only). */
  requests: { at: string; body: string }[];
  /** The member's current and recent tasks, unfinished first then newest; `tasksOmitted` counts the rest. */
  tasksOmitted: number;
  tasks: {
    id: string; title: string; status: TaskStatus; proposalState: 'active' | 'proposed';
    /** How the member is attached: its executor now, the reviewer a task in review waits for, or a former executor. */
    role: 'executor' | 'reviewer' | 'former';
    updatedAt: string;
    /** Always null: the Hub records commits, not the branch they were made on. */
    branch: null;
    commitSha: string | null;
    mergedCommitSha: string | null;
    /** The newest submission's summary, verbatim (cut to HANDOVER.summaryChars). */
    summary: string | null;
    /** The member whose submission it is; null when the task has no submission. */
    submissionBy: string | null;
    /** Always null: the Hub keeps no record of the commands a task ran. */
    commands: null;
    review: { verdict: 'approve' | 'reject'; self: boolean; reviewer: string; at: string; reason: string } | null;
    /** Unresolved attention questions, oldest first. */
    questions: string[];
  }[];
  /** The member's recent failed or offline deliveries (or failed/unknown results), newest first. */
  deliveries: { at: string | null; state: DeliveryState; outcome: DeliveryResult | null; error: string | null; message: string }[];
}

export interface HandoverInput {
  member: Pick<Member, 'id' | 'name' | 'harness' | 'model' | 'cwd' | 'workerSessionId'>;
  cluster: Pick<Cluster, 'id' | 'name'>;
  generatedAt: string;
  /** The newest user messages of the cluster, oldest first. */
  requests: Message[];
  tasks: MemberTaskFacts[];
  /** How many of the member's tasks the limit left out. */
  tasksOmitted: number;
  /** The member's recent failed deliveries, newest first, with the messages that did not get through. */
  deliveries: { delivery: Delivery; message: Message; at: string | null }[];
}

/** Shapes already-read records into the package; a missing record stays null rather than becoming a guess. */
export function handoverPackage(input: HandoverInput): HandoverPackage {
  const { member, cluster } = input;
  return {
    member: { id: member.id, name: member.name, harness: member.harness, model: member.model,
      cwd: member.cwd, sessionId: member.workerSessionId },
    cluster: { id: cluster.id, name: cluster.name },
    generatedAt: input.generatedAt,
    requests: input.requests.map((message) => ({ at: message.createdAt, body: excerpt(message.body, HANDOVER.requestChars) })),
    tasksOmitted: input.tasksOmitted,
    tasks: input.tasks.map((facts) => ({
      id: facts.task.id, title: facts.task.title, status: facts.task.status, proposalState: facts.task.proposalState,
      role: facts.role, updatedAt: facts.task.updatedAt,
      branch: null,
      commitSha: facts.commitSha,
      mergedCommitSha: facts.mergedCommitSha,
      summary: facts.summary === null ? null : excerpt(facts.summary, HANDOVER.summaryChars),
      submissionBy: facts.submissionBy,
      commands: null,
      review: facts.review && { verdict: facts.review.verdict, self: facts.review.self, reviewer: facts.review.reviewer,
        at: facts.review.at, reason: excerpt(facts.review.reason, HANDOVER.reasonChars) },
      questions: facts.questions.map((question) => excerpt(question, HANDOVER.questionChars)),
    })),
    deliveries: input.deliveries.map(({ delivery, message, at }) => ({
      at, state: delivery.state, outcome: delivery.outcome,
      error: delivery.error === null ? null : excerpt(delivery.error, HANDOVER.errorChars),
      message: excerpt(message.body, HANDOVER.messageChars),
    })),
  };
}
