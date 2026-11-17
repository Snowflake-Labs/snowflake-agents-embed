// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import type { ComponentType } from 'react'
import {
  Paperclip, Telescope, Puzzle, Globe, ChevronRight, ChevronDown, Plus, Info, X,
  GraduationCap, MessageSquare, Bot, Search, Menu, Pin, Archive, Pencil, Trash2, PanelLeftClose,
  Check, LoaderCircle, TriangleAlert, Unplug,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'

export interface IconProps {
  className?: string
  size?: number
}

// lucide's default strokeWidth (2) is tuned for its native 24px viewBox. Every icon here
// renders at --icon-sm (16px) or --icon-md (20px) - see tokens.css - where that stroke reads
// thin once the SVG is scaled down by CSS. Bumping stroke-width as size shrinks keeps the
// optical weight roughly constant across the sizes actually in use; --icon-lg is reserved
// for a future larger context and isn't exercised by any current call site.
function strokeWidthFor(size: number): number {
  if (size <= 16) return 2
  if (size <= 20) return 1.75
  return 1.5
}

// Every one of the exports below keeps its original name and { className } call
// signature so the 9 importing modules (ComposerMenu, AgentPill, DeepResearchChip,
// ThinkingToggle, ChatControls, AttachmentBar, SideNav, AppShell, HistoryItem) need no
// changes beyond an occasional explicit `size` at a call site rendered larger than the
// 16px default (see ComposerMenu's icon-box icons).
function wrap(Lucide: ComponentType<LucideProps>) {
  return function Icon({ className, size = 16 }: IconProps) {
    return <Lucide className={className} size={size} strokeWidth={strokeWidthFor(size)} aria-hidden="true" />
  }
}

export const PaperclipIcon = wrap(Paperclip)
export const TelescopeIcon = wrap(Telescope)
export const PuzzleIcon = wrap(Puzzle)
export const GlobeIcon = wrap(Globe)
export const ChevronRightIcon = wrap(ChevronRight)
export const ChevronDownIcon = wrap(ChevronDown)
export const PlusIcon = wrap(Plus)
export const InfoIcon = wrap(Info)
export const XIcon = wrap(X)
export const GraduationCapIcon = wrap(GraduationCap)
export const ChatBubbleIcon = wrap(MessageSquare)
export const AgentIcon = wrap(Bot)
export const SearchIcon = wrap(Search)
export const MenuIcon = wrap(Menu)
export const PinIcon = wrap(Pin)
export const ArchiveIcon = wrap(Archive)
export const PencilIcon = wrap(Pencil)
export const TrashIcon = wrap(Trash2)
export const PanelCollapseIcon = wrap(PanelLeftClose)
// Reasoning-panel step states. SpinnerIcon is rotated by CSS (.spinner in chat.css) - an SVG
// transform is GPU-composited and geometrically stable, unlike the "⟳" text glyph it replaces,
// which jittered as it rotated and fell back to a different shape per platform.
export const SpinnerIcon = wrap(LoaderCircle)
export const CheckIcon = wrap(Check)
export const WarningIcon = wrap(TriangleAlert)
export const PlugIcon = wrap(Unplug)
