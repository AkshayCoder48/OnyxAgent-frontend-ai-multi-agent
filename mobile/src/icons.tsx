import React, { createElement, type ReactNode } from 'react';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { ICONS } from './icons-data';

export type IconEntry = { svgAttrs: string; tags: string[] };

export type IconName = string & keyof typeof ICONS;

const CAMEL: Record<string, string> = {
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  'stroke-opacity': 'strokeOpacity',
  'fill-opacity': 'fillOpacity',
};
const camelize = (k: string) => CAMEL[k] ?? k.replace(/-(.)/g, (_, c) => c.toUpperCase());

const ATTR_RE = /([a-zA-Z-]+)="([^"]*)"/g;

function parseAttrs(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) out.push([m[1], m[2]]);
  return out;
}

const NUM_RE = /^-?\d+(\.\d+)?$/;

function toProps(raw: string, color: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [k, v] of parseAttrs(raw)) {
    let val: unknown = v === 'currentColor' ? color : v;
    if (val === 'none' || val === 0) {
      // keep literal
    } else if (typeof val === 'string' && NUM_RE.test(val) && k !== 'd') {
      val = Number(val);
    }
    props[camelize(k)] = val;
  }
  return props;
}

const COMP: Record<string, unknown> = { path: Path, rect: Rect, circle: Circle };

function renderTag(tag: string, color: string, key: number): ReactNode {
  const name = tag.slice(1).split(/[\s>]/, 1)[0];
  const Comp = COMP[name];
  if (!Comp) return null;
  return createElement(Comp as React.ComponentType<Record<string, unknown>>, {
    key,
    ...toProps(tag, color),
  });
}

export function Icon({
  name,
  size = 24,
  color = '#fff',
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: object;
}) {
  const e = ICONS[name];
  if (!e) return null;
  const svgProps = toProps(e.svgAttrs, color);
  return (
    <Svg width={size} height={size} {...(svgProps as object)} style={style as never}>
      {e.tags.map((t, i) => renderTag(t, color, i))}
    </Svg>
  );
}
