'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Select } from '@07ps/ui';
import { BASE, type Row } from '../../lib/pdp/api';
import { usePdp } from '../../lib/pdp/hooks';
import { copy as t, enumLabel, STATUS_COLOR } from '../../lib/pdp/text';
import type { SectionProps } from './PdpPage';
import { Chip, Empty, Loaded, Section, fmtDate } from './ui';
import s from './PdpVisuals.module.css';

const QUARTERS = [1, 2, 3, 4];

/** Horizontal timeline: the roadmap years (2023-2028, themes from the deck) in quarters, one lane per family. */
export function Roadmap({ options, revision }: SectionProps) {
  const roadmap = usePdp<Row>('/roadmap', revision);
  const [families, setFamilies] = useState<string[]>([]);
  return (
    <>
      <div className={s.toolbar}>
        <div style={{ width: 260 }}>
          <Select label="Family" options={(options.families as Row[]).map((f) => ({ value: String(f.family_id), label: f.name }))} value={families} onChange={setFamilies} multiSelect searchable placeholder="All families" />
        </div>
      </div>
      <Loaded state={roadmap} skeleton="chart">
        {(d) => {
          const years = (d.years as Row[]).map((y) => Number(y.year)).sort((a, b) => a - b);
          const items = (d.items as Row[]).filter((i) => families.length === 0 || families.includes(String(i.family_id)));
          if (!years.length || !(d.items as Row[]).length) return <Section title={t.roadmap.title}><Empty message={t.empty.roadmap} /></Section>;
          const first = years[0];
          const last = years[years.length - 1];
          const inRange = (i: Row) => i.quarter && Number(i.quarter.slice(0, 4)) >= first && Number(i.quarter.slice(0, 4)) <= last;
          const lanes = [...new Map(items.map((i) => [i.family_id, i.family])).entries()];
          const nowQ = `${d.today.slice(0, 4)}-Q${Math.floor((Number(d.today.slice(5, 7)) - 1) / 3) + 1}`;
          const columns = `minmax(150px, 180px) repeat(${years.length * 4}, minmax(46px, 1fr))`;
          const outside = items.filter((i) => !inRange(i));
          return (
            <Section title={t.roadmap.title} help={{ definition: t.roadmap.help }} testId="pdp-roadmap">
              <div className={s.legend} style={{ marginBottom: 10 }}>
                {['in_market', 'under_development', 'planned', 'discontinued'].map((st) => <Chip key={st} color={STATUS_COLOR[st]}>{enumLabel(st)}</Chip>)}
                <span style={{ border: '2px solid var(--ps-color-alert)', borderRadius: 6, padding: '1px 6px' }}>{t.late}</span>
                <span>≈ {t.flexible}</span>
              </div>
              {items.length === 0 ? (
                <Empty message={t.empty.treeFiltered} />
              ) : (
                <div className={s.timeline}>
                  <div className={s.timelineGrid} style={{ gridTemplateColumns: columns }}>
                    <div className={`${s.yearHead} ${s.laneHead}`} style={{ gridRow: 'span 2' }}>Family</div>
                    {years.map((y) => {
                      const theme = (d.years as Row[]).find((r) => Number(r.year) === y)?.theme ?? '';
                      return (
                        <div key={y} className={s.yearHead} style={{ gridColumn: 'span 4' }}>
                          <strong>{y}</strong>
                          <span dir="auto">{theme}</span>
                        </div>
                      );
                    })}
                    {years.flatMap((y) => QUARTERS.map((q) => (
                      <div key={`${y}q${q}`} className={`${s.quarterHead}${`${y}-Q${q}` === nowQ ? ` ${s.currentQuarter}` : ''}`}>Q{q}</div>
                    )))}
                    {lanes.flatMap(([fid, fname]) => [
                      <div key={`lane${fid}`} className={s.laneHead} dir="auto">{fname}</div>,
                      ...years.flatMap((y) => QUARTERS.map((q) => {
                        const here = items.filter((i) => i.family_id === fid && i.quarter === `${y}-Q${q}`);
                        return (
                          <div key={`${fid}-${y}-${q}`} className={s.cell}>
                            {here.map((i) => <Milestone key={i.product_id} i={i} />)}
                          </div>
                        );
                      })),
                    ])}
                  </div>
                </div>
              )}
              {outside.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12.5 }}>
                  <strong>Outside {first}–{last} or without a date:</strong>{' '}
                  {outside.map((i) => (
                    <span key={i.product_id} style={{ marginInlineEnd: 10 }}>
                      <Link href={`${BASE}/tree?product=${i.product_id}`}>{i.name}</Link> ({i.date ? fmtDate(i.date) : t.roadmap.noDate})
                    </span>
                  ))}
                </div>
              )}
            </Section>
          );
        }}
      </Loaded>
    </>
  );
}

function Milestone({ i }: { i: Row }) {
  const color = STATUS_COLOR[i.status];
  return (
    <Link
      href={`${BASE}/tree?product=${i.product_id}`}
      className={`${s.milestone}${i.late ? ` ${s.late}` : ''}`}
      style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, borderColor: color, color: 'var(--ps-color-text)' }}
      title={`${i.name} · ${enumLabel(i.status)} · ${fmtDate(i.date)}${i.flexible ? ` · ${t.flexible}` : ''}${i.late ? ` · ${t.late}` : ''}`}
      dir="auto"
    >
      {i.flexible ? '≈ ' : ''}
      {i.name}
    </Link>
  );
}
