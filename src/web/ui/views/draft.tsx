import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send } from 'lucide-react';
import { BackLink } from '@/components/back-link';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { type DraftMessageEntry, fetchDraft, sayInDraft } from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { projectHref } from '@/lib/router';
import { stateLabel, ticketTone } from '@/lib/status';

function Bubble({ message }: { message: DraftMessageEntry }) {
  const isYou = message.sender === 'stakeholder';
  return (
    <div className={`flex ${isYou ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg border px-3 py-2 ${isYou ? 'bg-secondary' : 'bg-muted/30'}`}>
        {!isYou ? <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">pm</p> : null}
        {isYou ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
        ) : (
          <div className="markdown text-sm leading-relaxed">
            <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

export function DraftView({ projectId, keyId }: { projectId: string; keyId: string }) {
  const { data, error, reload } = useResource(() => fetchDraft(projectId, keyId), [projectId, keyId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.messages.length, busy]);

  const send = async () => {
    if (!data || !text.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      await sayInDraft(projectId, keyId, text.trim());
      setText('');
      reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-3xl flex-col px-6 py-8">
      <BackLink fallback={projectHref(projectId, '/backlog')} />
      {error ? <p className="text-sm text-destructive">Failed to load draft: {error}</p> : null}
      {!data && !error ? <Skeleton className="h-40 w-full" /> : null}
      {data ? (
        <>
          <div className="mb-4 flex items-center gap-2.5">
            <span className="font-mono text-sm text-muted-foreground">{data.key}</span>
            <StatusBadge tone={ticketTone(data.status)} label={stateLabel(data.status)} />
            <h1 className="text-xl font-semibold tracking-tight">{data.title || data.description || 'Draft'}</h1>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border p-4">
            {data.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Pick up where you left off. Tell the PM more about what you want and they will help shape this draft.
              </p>
            ) : null}
            {data.messages.map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
            {busy ? <p className="text-xs text-muted-foreground">pm is thinking…</p> : null}
            <div ref={bottom} />
          </div>

          {failure ? <p className="mt-2 text-sm text-destructive">{failure}</p> : null}

          <div className="mt-3 flex items-end gap-2">
            <Textarea
              rows={2}
              value={text}
              placeholder="Continue your draft conversation with the PM"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button onClick={send} disabled={busy || !text.trim()}>
              <Send className="size-4" />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
