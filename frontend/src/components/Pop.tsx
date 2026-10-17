import { useEffect, useRef, useState, type ReactNode } from "react";

export default function Pop({ chip, children, className = "" }: { chip: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const place = () => {
      const card = ref.current?.querySelector(".pop-card");
      if (!(card instanceof HTMLElement)) return;
      card.classList.remove("flip");
      if (card.getBoundingClientRect().right > window.innerWidth - 8) card.classList.add("flip");
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", place);
    place();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <div className={`pop ${className}${open ? " open" : ""}`} ref={ref}>
      <button type="button" className="pop-chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{chip}</button>
      {open && <div className="pop-card">{children}</div>}
    </div>
  );
}

export function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="pop-rows">
      {rows.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}
