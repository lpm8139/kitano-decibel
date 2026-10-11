// art.js
// ロケット・星のイラスト（インライン SVG の文字列）。デザイン（design/gen_rocket_detail.py）と同じ形。

export function rocketSvg({ body = '#FFFFFF', accent = '#FF5A5F', flame = true, width = 72 } = {}) {
  const h = Math.round((width * 225) / 120);
  const fl = flame
    ? '<path class="flame" d="M40 150 L80 150 L60 220Z" fill="#FFB703"/><path class="flame-in" d="M48 150 L72 150 L60 196Z" fill="#FFF3B0"/>'
    : '';
  return `<svg width="${width}" height="${h}" viewBox="0 0 120 225" aria-hidden="true">
<path d="M30 120 L5 168 L34 150Z" fill="${accent}"/><path d="M90 120 L115 168 L86 150Z" fill="${accent}"/>
<path d="M60 0 C96 40 100 110 90 150 L30 150 C20 110 24 40 60 0Z" fill="${body}"/>
<path d="M60 0 C78 20 88 45 92 70 L28 70 C32 45 42 20 60 0Z" fill="${accent}"/>
<circle cx="60" cy="98" r="17" fill="#8ED6FF" stroke="#1D2042" stroke-width="5"/>${fl}</svg>`;
}

export const ghostRocketSvg = (width = 72) => rocketSvg({ body: '#E4DDFF', accent: '#8B7CF6', width });
export const avgRocketSvg = (width = 64) => rocketSvg({ body: '#D3F5EE', accent: '#22A699', width });

/** 星のイラスト。d = 直径(px)。土星だけ輪のぶん横に広い（幅 = d × 1.7）。 */
export function planetSvg(kind, d) {
  const r = d / 2;
  const c = (cx, cy, rr, fill, extra = '') => `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${fill}" ${extra}/>`;
  const e = (cx, cy, rx, ry, fill, extra = '') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
  const svg = (w, body) => `<svg width="${w}" height="${d}" viewBox="0 0 ${w} ${d}" aria-hidden="true">${body}</svg>`;
  switch (kind) {
    case 'earth':
      return svg(d, c(r, r, r, '#3A86FF') + e(r * 0.55, r * 0.35, r * 0.28, r * 0.14, '#4CC38A') + e(r * 1.3, r * 0.25, r * 0.22, r * 0.1, '#4CC38A') + e(r, r * 0.12, r * 0.5, r * 0.05, '#BFE3FF', 'opacity=".6"'));
    case 'moon':
      return svg(d, c(r, r, r, '#D9DAE6') + c(r * 0.62, r * 0.7, r * 0.16, '#B9BACB') + c(r * 1.25, r * 1.2, r * 0.22, '#B9BACB') + c(r * 1.3, r * 0.55, r * 0.1, '#B9BACB'));
    case 'mars':
      return svg(d, c(r, r, r, '#E4572E') + e(r * 0.7, r * 0.8, r * 0.3, r * 0.18, '#B8401F') + e(r * 1.3, r * 1.35, r * 0.25, r * 0.14, '#B8401F') + e(r, r * 0.12, r * 0.35, r * 0.1, '#FBE3D8'));
    case 'jupiter': {
      const id = `jc${Math.round(d)}`;
      const bands = [[0.35, 0.18, '#C98C5A'], [0.7, 0.12, '#F3D6A8'], [0.95, 0.2, '#B9774A'], [1.32, 0.14, '#F3D6A8'], [1.55, 0.12, '#C98C5A']]
        .map(([y, h, col]) => `<rect x="0" y="${r * y}" width="${d}" height="${r * h}" fill="${col}"/>`).join('');
      return svg(d, `<defs><clipPath id="${id}">${c(r, r, r, '#000')}</clipPath></defs>${c(r, r, r, '#E0B07A')}<g clip-path="url(#${id})">${bands}</g>${e(r * 1.25, r * 1.05, r * 0.2, r * 0.11, '#D2603A')}`);
    }
    case 'saturn': {
      const w = d * 1.7;
      const cx = w / 2;
      const ring = `stroke="#E9D9A6" stroke-width="${d * 0.07}" fill="none"`;
      return svg(w, `<ellipse cx="${cx}" cy="${r}" rx="${w * 0.48}" ry="${r * 0.3}" ${ring}/>${c(cx, r, r * 0.82, '#F0D58C')}<ellipse cx="${cx}" cy="${r * 0.72}" rx="${r * 0.74}" ry="${r * 0.06}" fill="#DDBB6A" opacity=".7"/><path d="M ${cx - w * 0.48} ${r} A ${w * 0.48} ${r * 0.3} 0 0 0 ${cx + w * 0.48} ${r}" ${ring}/>`);
    }
    case 'uranus':
      return svg(d, c(r, r, r, '#9FE3E8') + e(r, r, r * 0.95, r * 0.12, '#C7F1F3', 'opacity=".7"'));
    case 'neptune':
      return svg(d, c(r, r, r, '#4D6BFE') + e(r * 0.8, r * 0.7, r * 0.3, r * 0.12, '#2F49C9') + e(r * 1.2, r * 1.3, r * 0.2, r * 0.08, '#8EA2FF'));
    default:
      return '';
  }
}

/** 星の表示幅（土星は輪のぶん広い）。 */
export const planetWidth = (kind, d) => (kind === 'saturn' ? d * 1.7 : d);
