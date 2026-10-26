import { describe, expect, it } from 'vitest'
import { createActor } from './actor'
import { blankProject } from './model'
import { seededGen } from './ids'
import { mediaItemTemplate } from './mutations/media'

function setup(over: Record<string, unknown> = {}) {
  const idGen = seededGen()
  const actor = createActor({ initial: blankProject(idGen, 'external'), idGen })
  const media = { ...mediaItemTemplate(idGen(), 'Video', 1_000_000), path_abs: '/source/clip.mp4', ...over }
  actor.dispatch('add_media_item', { media })
  return { actor, id: media.id }
}

describe('copy_media_on_import', () => {
  it('defaults to true and is patched through update_project_settings', () => {
    const { actor } = setup()
    expect(actor.snapshot().settings.copy_media_on_import).toBe(true)
    expect(actor.command('update_project_settings', { patch: { copy_media_on_import: false } }).ok).toBe(true)
    expect(actor.snapshot().settings.copy_media_on_import).toBe(false)
    // A patch without the field leaves it alone; a non-boolean is ignored.
    actor.command('update_project_settings', { patch: { prefer_proxies: true } })
    actor.command('update_project_settings', { patch: { copy_media_on_import: 'yes' } })
    expect(actor.snapshot().settings.copy_media_on_import).toBe(false)
  })
})

describe('set_media_external (a cancelled copy made durable)', () => {
  it('marks the item external without recording an edit, and the mark survives undo', () => {
    const { actor, id } = setup()
    const before = actor.historyView(50).len
    expect(actor.command('set_media_external', { mediaId: id, external: true }).ok).toBe(true)
    expect(actor.snapshot().media_pool[id].external).toBe(true)
    expect(actor.historyView(50).len).toBe(before)
  })

  it('refuses once the workspace owns the file (the copy won the race), and an unknown id', () => {
    const { actor, id } = setup({ path_rel: 'Media/clip.mp4' })
    expect(actor.command('set_media_external', { mediaId: id, external: true }).ok).toBe(false)
    expect(actor.snapshot().media_pool[id].external).toBeFalsy()
    expect(actor.command('set_media_external', { mediaId: 'nope', external: true }).ok).toBe(false)
  })
})
