// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
interface Props {
  onSwitch: () => void
}

/**
 * A fork point exists once an edit or per-message regenerate has displaced a branch of the
 * conversation (see `forkAt`/`switchFork` in chatStore). Only one alternate is kept per fork
 * point, so this is a plain toggle rather than a full branch picker.
 */
export function ForkSwitcher({ onSwitch }: Props) {
  return (
    <div className="fork-switcher">
      <button className="action-btn" onClick={onSwitch}>↔ Switch to other response</button>
    </div>
  )
}
