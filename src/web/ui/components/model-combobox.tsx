import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

export interface ModelOption {
  value: string;
  price: string;
}

export function ModelCombobox({
  value,
  placeholder,
  options,
  onChange,
}: {
  value: string;
  placeholder?: string;
  options: ModelOption[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const needle = value.toLowerCase();
  const filtered = options.filter((o) => o.value.toLowerCase().includes(needle)).slice(0, 200);

  return (
    <div ref={wrap} className="relative">
      <Input
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
        }}
      />
      {open && filtered.length > 0 ? (
        <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="truncate font-mono text-xs">{o.value}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{o.price}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
