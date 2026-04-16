interface SparklineProps {
  values: Array<number | null>
  color?: string
  width?: number
  height?: number
}

export function Sparkline({ values, color = '#4ade80', width = 140, height = 28 }: SparklineProps) {
  const valid = values.map((v, i) => ({ i, v })).filter((p) => p.v !== null) as Array<{ i: number; v: number }>
  if (valid.length < 2) return <span className="dim">—</span>

  const minV = Math.min(...valid.map((p) => p.v))
  const maxV = Math.max(...valid.map((p) => p.v))
  const rangeV = maxV - minV || 0.001
  const maxI = values.length - 1 || 1

  const pts = valid.map((p) => {
    const x = (p.i / maxI) * width
    const y = height - ((p.v - minV) / rangeV) * (height - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const last = valid[valid.length - 1]
  const cx = ((last.i / maxI) * width).toFixed(1)
  const cy = (height - ((last.v - minV) / rangeV) * (height - 4) - 2).toFixed(1)

  return (
    <svg width={width} height={height} style={{ overflow: 'visible', verticalAlign: 'middle' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={cx} cy={cy} r={2.5} fill={color} />
    </svg>
  )
}
