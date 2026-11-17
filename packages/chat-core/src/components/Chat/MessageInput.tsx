// Copyright 2026 Snowflake Inc.
// SPDX-License-Identifier: Apache-2.0
import { useState, useRef, useEffect, useCallback, memo } from 'react'
import type { FileAttachment } from '../../types.js'
import type { AgentEntry, AgentSkillInfo } from '../../api/agents.js'
import { AttachmentBar } from './AttachmentBar.js'
import { ComposerMenu } from './composer/ComposerMenu.js'
import { AgentPill } from './composer/AgentPill.js'
import { ThinkingToggle } from './composer/ThinkingToggle.js'
import { DeepResearchChip } from './composer/DeepResearchChip.js'
import { LexicalComposerInput } from './composer/LexicalComposerInput.js'
import type { LexicalComposerInputHandle } from './composer/LexicalComposerInput.js'
import { useChatStore } from '../../store/chatStore.js'
import { useFileAttachments } from '../../hooks/useFileAttachments.js'
import { useVoiceDictation } from '../../hooks/useVoiceDictation.js'
import { extractMentionQuery, removeMention } from '../../lib/mentionQuery.js'
import { useFeatureFlags } from '../../lib/featureFlags.js'

interface Props {
  onSend: (text: string, attachments: FileAttachment[], skills?: AgentSkillInfo[]) => void
  disabled?: boolean
  /** The active thread's tempId, so drafts and @-mentions can key off it. Absent pre-thread. */
  tempId?: string
  snowflakeToken?: string
  agentFqn?: string
}

function MessageInputImpl({ onSend, disabled, tempId, snowflakeToken = '', agentFqn }: Props) {
  const flags = useFeatureFlags()
  const fileUploadEnabled = flags.fileUpload
  const richComposer = flags.richComposer
  const draft = useChatStore((s) => (tempId ? s.openThreads[tempId]?.draft : undefined)) ?? ''
  const setDraft = useChatStore((s) => s.setDraft)
  const agents = useChatStore((s) => s.agents)
  const setActiveAgent = useChatStore((s) => s.setActiveAgent)

  const [value, setValue] = useState(draft)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [skills, setSkills] = useState<AgentSkillInfo[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [committedVoiceText, setCommittedVoiceText] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lexicalRef = useRef<LexicalComposerInputHandle>(null)

  // Switching the active thread restores *that* thread's own in-progress draft instead of
  // carrying over whatever was being typed in the previous one, and - for keyboard/screen
  // reader users especially - moves focus into the composer so a "New chat" click or history
  // switch doesn't leave focus stranded on whatever was clicked.
  useEffect(() => {
    setValue(draft)
    if (richComposer) lexicalRef.current?.setText(draft)
    if (!disabled) {
      if (richComposer) lexicalRef.current?.focus()
      else inputRef.current?.focus()
    }
    // Only tempId: a thread switch restores that thread's draft. draft/disabled/richComposer
    // changing mid-thread must not steal focus or clobber in-progress typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tempId])

  const addAttachment = useCallback((a: FileAttachment) => setAttachments((prev) => [...prev, a]), [])
  const addFiles = useFileAttachments(addAttachment)

  const dictation = useVoiceDictation((transcript) => {
    setValue((prev) => {
      const next = prev ? `${prev} ${transcript}` : transcript
      if (tempId) setDraft(tempId, next)
      return next
    })
    // Mirrors the string-concat above into the Lexical editor itself - see VoiceAppendPlugin.
    if (richComposer) setCommittedVoiceText(transcript)
  })

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value
    setValue(next)
    if (tempId) setDraft(tempId, next)
    setMentionQuery(extractMentionQuery(next, e.target.selectionStart ?? next.length))
  }

  function handleLexicalChange(text: string, textBeforeCursor: string) {
    setValue(text)
    if (tempId) setDraft(tempId, text)
    setMentionQuery(extractMentionQuery(textBeforeCursor, textBeforeCursor.length))
  }

  function selectMention(agent: AgentEntry) {
    const prevTempId = tempId
    setActiveAgent(agent.fqn)
    const nextTempId = useChatStore.getState().activeThreadTempId
    const threadChanged = Boolean(nextTempId && nextTempId !== prevTempId)

    const applyMention = () => {
      if (richComposer) {
        lexicalRef.current?.insertMentionPillAtCursor(agent.fqn, agent.displayName)
        lexicalRef.current?.focus()
      } else {
        if (!threadChanged) {
          const pos = inputRef.current?.selectionStart ?? value.length
          const next = removeMention(value, pos)
          setValue(next)
          if (tempId) setDraft(tempId, next)
        }
        inputRef.current?.focus()
      }
      setMentionQuery(null)
    }

    // A new chat remounts composer state on the next paint (tempId effect). Insert the
    // mention pill after that reset so it lands on the empty composer, not the old draft.
    if (threadChanged && richComposer) {
      setMentionQuery(null)
      window.setTimeout(applyMention, 0)
    } else {
      applyMention()
    }
  }

  function clearComposer() {
    setValue('')
    setAttachments([])
    setSkills([])
    setMentionQuery(null)
    if (tempId) setDraft(tempId, '')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape' && (value || attachments.length > 0)) {
      clearComposer()
    }
  }

  function handleEscape() {
    if (value || attachments.length > 0) {
      clearComposer()
      lexicalRef.current?.clearEditor()
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!fileUploadEnabled) return
    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  function handleDrop(e: React.DragEvent) {
    if (!fileUploadEnabled) return
    e.preventDefault()
    void addFiles(e.dataTransfer.files)
  }

  function submit() {
    const text = value.trim()
    if ((!text && attachments.length === 0) || disabled) return
    onSend(text, attachments, skills)
    clearComposer()
    lexicalRef.current?.clearEditor()
  }

  function removeAttachment(i: number) {
    setAttachments((prev) => prev.filter((_, idx) => idx !== i))
  }

  function addSkill(skill: AgentSkillInfo) {
    setSkills((prev) => [...prev, skill])
  }

  function removeSkill(name: string) {
    setSkills((prev) => prev.filter((s) => s.name !== name))
  }

  const mentionMatches = mentionQuery !== null
    ? agents.filter((a) => a.displayName.toLowerCase().includes(mentionQuery.toLowerCase()))
    : []

  const canSend = Boolean(value.trim()) || attachments.length > 0

  return (
    <div
      className="message-input"
      onDragOver={fileUploadEnabled ? (e) => e.preventDefault() : undefined}
      onDrop={fileUploadEnabled ? handleDrop : undefined}
    >
      {mentionQuery !== null && mentionMatches.length > 0 && (
        <ul className="mention-menu">
          {mentionMatches.map((a) => (
            <li key={a.fqn}>
              <button type="button" onClick={() => selectMention(a)}>{a.displayName}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-card">
        {fileUploadEnabled && <AttachmentBar attachments={attachments} onRemove={removeAttachment} />}
        {skills.length > 0 && (
          <div className="skill-picker">
            {skills.map((s) => (
              <span key={s.name} className="skill-chip">
                {s.name}
                <button
                  type="button"
                  className="skill-chip-remove"
                  onClick={() => removeSkill(s.name)}
                  title={`Remove ${s.name}`}
                >✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-input-row">
          {richComposer ? (
            <LexicalComposerInput
              ref={lexicalRef}
              onChange={handleLexicalChange}
              onSubmit={submit}
              onEscape={handleEscape}
              onPasteFiles={fileUploadEnabled ? addFiles : undefined}
              disabled={disabled}
              placeholder="Ask anything..."
              isMentionMenuOpen={mentionQuery !== null && mentionMatches.length > 0}
              committedVoiceText={committedVoiceText}
              onCommittedVoiceTextAppended={() => setCommittedVoiceText(null)}
              interimVoiceText={dictation.interim}
            />
          ) : (
            <textarea
              ref={inputRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Ask anything..."
              disabled={disabled}
              rows={1}
            />
          )}
        </div>
        <div className="composer-toolbar">
          <ComposerMenu
            onAddFile={addAttachment}
            snowflakeToken={snowflakeToken}
            agentFqn={agentFqn}
            selectedSkills={skills}
            onAddSkill={addSkill}
            onRemoveSkill={removeSkill}
            disabled={disabled}
          />
          <AgentPill />
          <DeepResearchChip />
          <div className="composer-toolbar-spacer" />
          <ThinkingToggle />
          {dictation.supported && (
            <button
              type="button"
              className={`mic-btn${dictation.listening ? ' mic-btn--active' : ''}${dictation.error ? ' mic-btn--error' : ''}`}
              onClick={dictation.listening ? dictation.stop : dictation.start}
              disabled={disabled || dictation.probing}
              title={dictation.error ?? (dictation.listening ? 'Stop dictation' : 'Dictate')}
            >🎤</button>
          )}
          {dictation.error && <span className="ctrl-error">{dictation.error}</span>}
          {canSend && (
            <button type="button" className="send-btn" aria-label="Send" onClick={submit} disabled={disabled}>Send</button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Memoized: this hosts the Lexical editor, which is the most expensive subtree in the app to
 * re-render, and it has no reason to re-render while an answer streams. ChatContainer does
 * (it owns the transcript), so without this the composer was rebuilt on every delta.
 */
export const MessageInput = memo(MessageInputImpl)
