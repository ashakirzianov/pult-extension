// What the composer shows above itself, as entries of Pult's composer bar
// (`ThreadView.tsx`): upstream's notices, and the thread's sync and task
// progress. Upstream's composer renders these here instead of above itself
// while the app around the view provides the bar (`ComposerControlsSlot`).
import type { ThreadSyncPhase } from "../t3/src/threadSync";
import { ComposerActivityRow } from "../t3/src/components/chat/ComposerActivityStatus";
import { ComposerBanner } from "../t3/src/components/chat/ComposerBanner";
import type { ComposerBannerStackItem } from "../t3/src/components/chat/ComposerBannerStack";
import {
  ComposerTasksBadge,
  ComposerTasksContent,
} from "../t3/src/components/chat/ComposerTasksBadge";
import type {
  ComposerTaskStep,
  ComposerTasksProgress,
} from "../t3/src/components/chat/ComposerTasksBadge";
import { Popover, PopoverPopup, PopoverTrigger } from "../t3/src/components/ui/popover";
import { useLayoutEffect, useRef } from "react";

/** Upstream's stack order: urgent, errors and warnings first, then activity, then the rest. */
function noticeRank(item: ComposerBannerStackItem) {
  if (item.priority === "urgent" || item.variant === "error" || item.variant === "warning") {
    return 0;
  }
  return item.priority === "activity" ? 1 : 2;
}

/** One notice in full, as upstream's stack shows it. */
function Notice({ item }: { readonly item: ComposerBannerStackItem }) {
  return (
    <ComposerBanner.Root
      role="alert"
      placement="floating"
      variant={item.variant}
      density="comfortable"
    >
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="block whitespace-normal wrap-anywhere">
          <span className="font-medium">{item.title}</span>
          {item.description ? (
            <span className="block text-muted-foreground">{item.description}</span>
          ) : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions>
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                onClick={item.onDismiss}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}

/**
 * The notices as one entry: the first by upstream's order, its icon and
 * title, and how many more, a button that opens them all in full above the
 * bar; then the first one's actions and dismissal.
 */
export function ComposerBarNotices({
  items,
}: {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
}) {
  // The background work notice lists the thread's working subagents, which its card in the shell lists already.
  const ordered = items
    .filter((item) => !item.id.startsWith("background-work:"))
    .toSorted((a, b) => noticeRank(a) - noticeRank(b));
  const front = ordered[0];
  if (front === undefined) return null;
  return (
    <div className="pult-bar-notice" data-variant={front.variant}>
      <Popover>
        <PopoverTrigger
          render={<button type="button" className="pult-bar-notice-summary" />}
          aria-label={ordered.length > 1 ? `${ordered.length} notices` : "Notice details"}
        >
          <span className="pult-bar-notice-icon">{front.icon}</span>
          <span className="pult-bar-notice-title">{front.title}</span>
          {ordered.length > 1 ? (
            <span className="pult-bar-notice-count">+{ordered.length - 1}</span>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          aria-label="Notices"
          className="w-[min(32rem,calc(100vw-2rem))]"
        >
          <div className="flex max-h-[min(var(--available-height),28rem)] flex-col gap-2 overflow-y-auto">
            {ordered.map((item) => (
              <Notice key={item.id} item={item} />
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      {front.actions || front.onDismiss ? (
        <span className="pult-bar-notice-actions">
          {front.actions}
          {front.onDismiss ? (
            <ComposerBanner.Dismiss
              aria-label={front.dismissLabel ?? "Dismiss warning"}
              onClick={front.onDismiss}
            />
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The thread's activity: while its messages load or sync, that; else its
 * task progress, a button that opens the task list above the bar.
 */
export function ComposerBarActivity({
  phase,
  progress,
  steps,
  tasksOpen,
  onTasksOpenChange,
}: {
  readonly phase: ThreadSyncPhase | null;
  readonly progress: ComposerTasksProgress | null;
  readonly steps: readonly ComposerTaskStep[] | null;
  readonly tasksOpen: boolean;
  readonly onTasksOpenChange: (open: boolean) => void;
}) {
  if (phase !== null) {
    return (
      <div className="pult-bar-activity">
        <ComposerActivityRow phase={phase} />
      </div>
    );
  }
  if (progress === null || steps === null || progress.totalSteps <= 0) return null;
  return (
    <Popover open={tasksOpen} onOpenChange={onTasksOpenChange}>
      {/* The badge is upstream's button; the trigger around it opens and closes the list. */}
      <PopoverTrigger render={<span className="pult-bar-activity" />}>
        <ComposerTasksBadge
          expanded={tasksOpen}
          onToggle={() => {}}
          placement="inline"
          progress={progress}
          steps={steps}
        />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        aria-label="Tasks"
        className="w-[min(28rem,calc(100vw-2rem))]"
      >
        <ComposerTasksContent
          expanded
          onToggle={() => onTasksOpenChange(false)}
          progress={progress}
          steps={steps}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Where the composer bar sits while a composer is mounted: at the end of the
 * composer's form, under its message, so the buttons in it submit the form
 * as upstream's do. The bar is the shell's element (`ThreadView.tsx`), moved
 * here and back to where it was when the composer goes, as for a thread
 * that mounts none.
 */
export function ComposerBarHost({
  slot,
  draft,
}: {
  readonly slot: HTMLElement;
  readonly draft: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    const home = slot.parentElement;
    element.append(slot);
    return () => {
      if (home !== null && slot.parentElement === element) home.append(slot);
    };
  }, [slot]);
  return <div ref={host} data-chat-composer-bar-host={draft ? "draft" : "thread"} />;
}
