import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, CheckSquare, Mic, MicOff, Plus, Send, Volume2, VolumeX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  concludeMeetingApi,
  createMeeting,
  fetchBoard,
  fetchConfig,
  fetchMeeting,
  fetchMeetings,
  sayInMeeting,
  type MeetingMessageEntry,
} from '@/lib/api';
import { useResource } from '@/lib/hooks';
import { navigate, projectHref, projectPath } from '@/lib/router';

const BUILTIN = ['pm', 'architect', 'developer', 'reviewer', 'uat'];

type Recognition = { start: () => void; stop: () => void } & EventTarget;

function speechRecognition(): (new () => any) | null {
  const w = globalThis as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function invitable(pipeline: string[]): string[] {
  const custom = pipeline.filter((s) => !BUILTIN.includes(s));
  return [...new Set(['pm', 'planner', 'architect', 'reviewer', ...custom])];
}

function NewMeetingDialog({ projectId, pipeline }: { projectId: string; pipeline: string[] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [link, setLink] = useState('none');
  const { data: board } = useResource(() => fetchBoard(projectId), [projectId]);
  const linkable = [
    ...(board?.epics ?? []).map((e) => ({ key: e.key, label: `${e.key} · ${e.title}`, epic: true })),
    ...[...(board?.standaloneTickets ?? []), ...(board?.epics ?? []).flatMap((e) => e.subtickets)]
      .filter((t) => t.status !== 'DONE')
      .map((t) => ({ key: t.key, label: `${t.key} · ${t.title || t.description.slice(0, 60)}`, epic: false })),
  ];
  const [picked, setPicked] = useState<string[]>(['pm']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (role: string) =>
    setPicked((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = linkable.find((l) => l.key === link);
      const meeting = await createMeeting(projectId, {
        title: title.trim() || 'Working meeting',
        participants: picked,
        ...(chosen && !chosen.epic ? { ticketKey: chosen.key } : {}),
        ...(chosen?.epic ? { epicKey: chosen.key } : {}),
      });
      navigate(projectPath(projectId, `/meetings/${meeting.id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> New meeting
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New meeting</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Invite</p>
            <div className="flex flex-wrap gap-1.5">
              {invitable(pipeline).map((role) => (
                <Button
                  key={role}
                  type="button"
                  size="sm"
                  variant={picked.includes(role) ? 'secondary' : 'outline'}
                  className="h-7 px-2 text-xs capitalize"
                  onClick={() => toggle(role)}
                >
                  {picked.includes(role) ? `● ${role}` : role}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">About (optional; its context is shared with participants)</p>
            <Select value={link} onValueChange={setLink}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                <SelectItem value="none">Nothing specific</SelectItem>
                {linkable.map((l) => (
                  <SelectItem key={l.key} value={l.key}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button onClick={start} disabled={busy || picked.length === 0}>
            {busy ? 'Starting…' : 'Start meeting'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Bubble({ message }: { message: MeetingMessageEntry }) {
  const isYou = message.speaker === 'you';
  return (
    <div className={`flex ${isYou ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg border px-3 py-2 ${isYou ? 'bg-secondary' : 'bg-muted/30'}`}>
        {!isYou ? <p className="mb-0.5 text-[11px] font-medium capitalize text-muted-foreground">{message.speaker}</p> : null}
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

function MeetingRoom({ projectId, meetingId }: { projectId: string; meetingId: string }) {
  const { data, error, reload } = useResource(() => fetchMeeting(projectId, meetingId), [projectId, meetingId]);
  const [text, setText] = useState('');
  const [to, setTo] = useState('auto');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ summary: string; createdTickets: string[] } | null>(null);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const recognizer = useRef<Recognition | null>(null);
  const spokenUpTo = useRef<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const voiceCapable = speechRecognition() !== null;

  useEffect(() => {
    const messages = data?.messages ?? [];
    const last = messages.at(-1);
    if (spokenUpTo.current === null) {
      spokenUpTo.current = last?.id ?? 0;
      return;
    }
    if (!speak || !last || last.speaker === 'you' || last.id <= spokenUpTo.current) return;
    spokenUpTo.current = last.id;
    const utterance = new SpeechSynthesisUtterance(last.text.replace(/[`*#_>-]/g, ' '));
    globalThis.speechSynthesis?.speak(utterance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.messages, speak]);

  const toggleMic = () => {
    if (listening) {
      recognizer.current?.stop();
      setListening(false);
      return;
    }
    const Ctor = speechRecognition();
    if (!Ctor) return;
    const rec: any = new Ctor();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (event: any) => {
      const chunk = [...event.results].slice(event.resultIndex).map((r: any) => r[0].transcript).join(' ');
      setText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${chunk.trim()}`);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognizer.current = rec;
    rec.start();
    setListening(true);
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [data?.messages.length, busy]);

  const agents = (data?.participants ?? []).filter((p) => p !== 'you');

  const send = async () => {
    if (!data || !text.trim()) return;
    const addressed = to === 'auto' ? null : to;
    const mention = /^@([a-z][a-z0-9-]*)/i.exec(text.trim())?.[1]?.toLowerCase();
    setBusy(addressed ?? (mention && agents.includes(mention) ? mention : agents[0]) ?? 'agent');
    setFailure(null);
    try {
      await sayInMeeting(projectId, data.id, text.trim(), addressed);
      setText('');
      reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const conclude = async () => {
    if (!data) return;
    setBusy('minutes');
    setFailure(null);
    try {
      setOutcome(await concludeMeetingApi(projectId, data.id));
      reload();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] max-w-3xl flex-col px-6 py-8">
      <a
        href={projectHref(projectId, '/meetings')}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Meetings
      </a>
      {error ? <p className="text-sm text-destructive">Failed to load: {error}</p> : null}
      {!data && !error ? <Skeleton className="h-40 w-full" /> : null}
      {data ? (
        <>
          <div className="mb-4 flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{data.title}</h1>
            <Badge variant="muted" className="capitalize">
              {data.participants.filter((p) => p !== 'you').join(', ')}
            </Badge>
            {data.status === 'ENDED' ? <Badge variant="outline">ended</Badge> : null}
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                title={speak ? 'Stop speaking replies aloud' : 'Speak replies aloud'}
                onClick={() => {
                  if (speak) globalThis.speechSynthesis?.cancel();
                  setSpeak(!speak);
                }}
              >
                {speak ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
              </Button>
              {data.status === 'OPEN' ? (
                <Button size="sm" variant="outline" onClick={conclude} disabled={busy !== null}>
                  <CheckSquare className="size-4" /> Conclude
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border p-4">
            {data.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">Say something to start the meeting.</p>
            ) : null}
            {data.messages.map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
            {busy && busy !== 'minutes' ? (
              <p className="text-xs text-muted-foreground">{busy} is thinking…</p>
            ) : null}
            {busy === 'minutes' ? <p className="text-xs text-muted-foreground">writing minutes…</p> : null}
            <div ref={bottom} />
          </div>

          {outcome ? (
            <Card className="mt-3">
              <CardContent className="space-y-2 p-4">
                <p className="text-xs font-medium text-muted-foreground">Minutes</p>
                <div className="markdown text-sm leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]}>{outcome.summary}</Markdown>
                </div>
                {outcome.createdTickets.length ? (
                  <p className="text-sm">
                    Action items:{' '}
                    {outcome.createdTickets.map((key, i) => (
                      <span key={key}>
                        {i > 0 ? ', ' : ''}
                        <a className="underline" href={projectHref(projectId, `/tickets/${key}`)}>
                          {key}
                        </a>
                      </span>
                    ))}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No action items.</p>
                )}
              </CardContent>
            </Card>
          ) : null}
          {data.status === 'ENDED' && !outcome && data.summary ? (
            <Card className="mt-3">
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium text-muted-foreground">Minutes</p>
                <div className="markdown text-sm leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]}>{data.summary}</Markdown>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {failure ? <p className="mt-2 text-sm text-destructive">{failure}</p> : null}

          {data.status === 'OPEN' ? (
            <div className="mt-3 flex items-end gap-2">
              <Select value={to} onValueChange={setTo}>
                <SelectTrigger className="w-32 shrink-0 capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a} value={a} className="capitalize">
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea
                rows={2}
                value={text}
                placeholder="Say something; @mention a participant to address them"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {voiceCapable ? (
                <Button
                  variant={listening ? 'secondary' : 'outline'}
                  title={listening ? 'Stop dictating' : 'Dictate'}
                  onClick={toggleMic}
                >
                  {listening ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                </Button>
              ) : null}
              <Button onClick={send} disabled={busy !== null || !text.trim()}>
                <Send className="size-4" />
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function MeetingsView({ projectId, meetingId }: { projectId: string; meetingId?: string }) {
  const { data: meetings, error } = useResource(() => fetchMeetings(projectId), [projectId, meetingId]);
  const { data: config } = useResource(() => fetchConfig(projectId), [projectId]);

  if (meetingId) return <MeetingRoom projectId={projectId} meetingId={meetingId} />;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
        <NewMeetingDialog projectId={projectId} pipeline={config?.config.pipeline ?? BUILTIN} />
      </div>
      {error ? <p className="mt-6 text-sm text-destructive">{error}</p> : null}
      {meetings && meetings.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          No meetings yet. Start one to refine a request with the PM, consult the architect, or plan an epic with the
          planner; concluding a meeting turns agreed action items into tickets.
        </p>
      ) : null}
      <div className="mt-6 divide-y overflow-hidden rounded-lg border">
        {(meetings ?? []).map((m) => (
          <a
            key={m.id}
            href={projectHref(projectId, `/meetings/${m.id}`)}
            className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent/40"
          >
            <span className="flex-1 truncate font-medium">{m.title}</span>
            <span className="text-xs capitalize text-muted-foreground">
              {m.participants.filter((p) => p !== 'you').join(', ')}
            </span>
            <Badge variant={m.status === 'OPEN' ? 'muted' : 'outline'}>{m.status.toLowerCase()}</Badge>
          </a>
        ))}
      </div>
    </div>
  );
}
