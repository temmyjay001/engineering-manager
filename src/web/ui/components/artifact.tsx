import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index '))
    return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  del: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
  hunk: 'text-sky-700 dark:text-sky-300',
  meta: 'text-muted-foreground',
  context: '',
};

function DiffView({ content }: { content: string }) {
  const lines = content.replace(/\n$/, '').split('\n');
  return (
    <div className="overflow-x-auto rounded-lg border bg-muted/20 font-mono text-xs leading-relaxed">
      <div className="w-max min-w-full">
        {lines.map((line, i) => {
          const kind = classifyDiffLine(line);
          return (
            <div key={i} className={cn('whitespace-pre px-3', DIFF_LINE_CLASS[kind])}>
              {line || ' '}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarkdownView({ content }: { content: string }) {
  return (
    <div className="markdown max-h-[32rem] overflow-auto rounded-lg border bg-muted/20 p-4">
      <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
    </div>
  );
}

export interface EvidenceMeta {
  name: string;
  mime: string;
}

export function evidenceMeta(data: string | null | undefined): EvidenceMeta | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Partial<EvidenceMeta>;
    if (typeof parsed.name === 'string' && typeof parsed.mime === 'string') {
      return { name: parsed.name, mime: parsed.mime };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function EvidenceView({ content, data }: { content: string; data?: string | null }) {
  const meta = evidenceMeta(data);
  const mime = meta?.mime ?? 'image/png';
  const caption = meta ? <figcaption className="font-mono text-xs text-muted-foreground">{meta.name}</figcaption> : null;

  if (mime.startsWith('text/')) {
    return (
      <figure className="space-y-2 rounded-lg border bg-muted/20 p-4">
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{content}</pre>
        {caption}
      </figure>
    );
  }

  return (
    <figure className="space-y-2 rounded-lg border bg-muted/20 p-4">
      <img
        src={`data:${mime};base64,${content}`}
        alt={meta?.name ?? 'UAT evidence'}
        className="max-h-[32rem] w-auto max-w-full rounded-md border"
      />
      {caption}
    </figure>
  );
}

export function ArtifactContent({ kind, content, data }: { kind: string; content: string; data?: string | null }) {
  if (kind === 'DIFF') return <DiffView content={content} />;
  if (kind === 'EVIDENCE' || kind === 'ATTACHMENT') return <EvidenceView content={content} data={data} />;
  return <MarkdownView content={content} />;
}
