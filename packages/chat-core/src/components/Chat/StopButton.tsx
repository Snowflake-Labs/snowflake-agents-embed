// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
interface Props {
  onStop: () => void
}

export function StopButton({ onStop }: Props) {
  return (
    <button className="stop-btn" onClick={onStop} title="Stop displaying this response — the run keeps going on Snowflake">
      <span className="stop-icon">■</span> Stop
    </button>
  )
}
