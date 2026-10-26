//! `Project` — the top-level state. Single source of truth shared between the
//! UI, IR compiler, MCP server, and persistence layer.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::audio_role::{AudioRole, RoleMixSettings};
use super::composition::Composition;
use super::ids::{new_id, CompositionId, MediaId};
use super::media::MediaItem;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    /// `.vproj` schema version. **TS owns this number** — `state/model.ts`'s
    /// `SCHEMA_VERSION`, with the upgrade chain in `state/migrate.ts` and the
    /// gate in `state/persistence.ts`. Rust round-trips it opaquely: it never
    /// reads the value, never gates on it, and never writes a project to disk,
    /// so a constant here would be a version claim with no reader (ADR 0047).
    /// The fixtures in this crate's tests therefore write any valid version.
    pub schema_version: u32,
    pub project_id: Uuid,
    pub metadata: ProjectMetadata,
    /// Every timeline of the project — the root and each Group — keyed by
    /// `Composition::id` (ADR 0052 §3). Required on the wire, like `root_id`:
    /// a file without them is the pre-container shape and must fail to load
    /// rather than deserialize to an empty project.
    ///
    /// `OrdMap`, not `HashMap`: imbl's `HashMap` iterates in `RandomState`
    /// order, so two serializations of the same two-entry map could differ and
    /// `project_json_round_trip`'s byte-identity would be order-flaky. Sorted
    /// keys are deterministic (same reason `Link.members` is an `OrdSet`). TS
    /// writes insertion order; nothing compares TS bytes to Rust bytes.
    pub compositions: imbl::OrdMap<CompositionId, Composition>,
    /// Key of the root composition in `compositions`. TS validates that it
    /// resolves (`ValidationError::RootMissing`); `root()` trusts it.
    pub root_id: CompositionId,
    /// The `Composition::ordinal` the next Group takes. **TS owns it** — Rust
    /// neither advances nor reads it. Declared anyway because serde drops what
    /// no field names, and this one sits OUTSIDE the `compositions` subtree the
    /// fixture round-trip compares, so a drop here would surface nowhere.
    /// `#[serde(default)]`: TS always writes it.
    #[serde(default)]
    pub next_group_ordinal: u32,
    pub media_pool: imbl::HashMap<MediaId, MediaItem>,
    /// Per-role mix-bus settings (`docs/audio.md`). Absent keys resolve to
    /// `RoleMixSettings::default()` via `role_mix`. `#[serde(default)]`
    /// makes pre-roles `.vproj` files load with every role at unity.
    #[serde(default)]
    pub audio_roles: imbl::HashMap<AudioRole, RoleMixSettings>,
    pub settings: ProjectSettings,
}

impl Project {
    pub fn new_blank(name: impl Into<String>) -> Self {
        let now = Utc::now();
        // Mint order mirrors TS `blankProject` (model.ts): A roll, B roll,
        // project_id, root_id — the skeleton before the two ids that name it.
        let tracks = Composition::skeleton_tracks();
        let project_id = new_id();
        let root_id = new_id();
        let root = Composition::from_skeleton(root_id, None, tracks);
        Self {
            // TS owns the real number (see the field doc); this is a fixture.
            schema_version: 1,
            project_id,
            metadata: ProjectMetadata {
                name: name.into(),
                created_at: now,
                modified_at: now,
                description: None,
            },
            compositions: imbl::OrdMap::unit(root_id, root),
            root_id,
            next_group_ordinal: 1,
            media_pool: imbl::HashMap::new(),
            audio_roles: imbl::HashMap::new(),
            settings: ProjectSettings::default(),
        }
    }

    /// The root composition. Panics if `root_id` does not resolve — TS
    /// validates that before any project reaches Rust.
    pub fn root(&self) -> &Composition {
        self.compositions
            .get(&self.root_id)
            .expect("validated: root_id resolves")
    }

    pub fn root_mut(&mut self) -> &mut Composition {
        self.compositions
            .get_mut(&self.root_id)
            .expect("validated: root_id resolves")
    }

    pub fn composition(&self, id: &CompositionId) -> Option<&Composition> {
        self.compositions.get(id)
    }

    /// Mix settings for a role, defaulted when the table has no entry.
    pub fn role_mix(&self, role: AudioRole) -> RoleMixSettings {
        self.audio_roles.get(&role).cloned().unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectMetadata {
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectSettings {
    /// Declared preview resolution. Wire-only — nothing reads the pair today;
    /// the Pixi preview sizes off the composition and the playback-resolution
    /// setting.
    pub preview_width: u32,
    pub preview_height: u32,
    pub autosave_interval_secs: Option<u32>,
    pub history_capacity: usize,
    /// When `true` (default), importing a video source that has an audio
    /// stream creates both a `VideoClip` and an `Audio` layer pointing at
    /// the same media, and links them. See `docs/features.md#links`. When
    /// `false`, only the `VideoClip` layer is created (audio is silently
    /// dropped).
    #[serde(default = "default_auto_pair_audio_on_import")]
    pub auto_pair_audio_on_import: bool,
    /// When `true`, preview decode prefers a generated proxy over the
    /// original source (per-clip `proxy_overrides` can force either way).
    /// Default `false` (native-decode-always, matching NLE convention).
    #[serde(default)]
    pub prefer_proxies: bool,
    /// Per-clip override of `prefer_proxies`, keyed by media id. Absent =
    /// follow the global preference. See `project_settings_patch_convention`.
    #[serde(default)]
    pub proxy_overrides: std::collections::HashMap<String, bool>,
    /// The Shots Panel's reviewed detection parameters, or `None` for the
    /// detector's own defaults. **TS owns and reads it** (`state/model.ts`
    /// `ShotReviewSettings`); Rust only round-trips it. Declared anyway because
    /// serde drops what no field names, and this one sits outside the
    /// `compositions` subtree the fixture test compares, so an unnamed field
    /// would vanish silently on the way through.
    #[serde(default)]
    pub shot_review: Option<ShotReviewSettings>,
    /// The Pauses section's detection parameters, or `None` for the detector's
    /// own defaults. **TS owns and reads it** (`state/model.ts`
    /// `PauseReviewSettings`); Rust only round-trips it, for the same reason
    /// `shot_review` is declared here.
    #[serde(default)]
    pub pause_review: Option<PauseReviewSettings>,
    /// When `false`, the automatic import/open fan-out does NOT build the
    /// preview (quick) proxy. Export masters are unaffected: a source whose
    /// export needs one still gets it on demand, and an explicit "Generate
    /// proxy" still builds. **TS owns it** (`state/model.ts`); Rust mirrors it
    /// for the job layer, which receives it through
    /// `enqueue_jobs_for_media`. Default `true`.
    #[serde(default = "default_generate_preview_proxies")]
    pub generate_preview_proxies: bool,
    /// When the full export master of a source that previews from a proxy is
    /// built: `Auto` (only when the native export decoder is unavailable —
    /// otherwise export decodes the original natively), `OnImport` (always, at
    /// import: upstream's behaviour) or `OnDemand` (never at import; the export
    /// gate builds it if the export cannot read the original). **TS owns it**
    /// and resolves it against decoder availability (`shared/exportMasters.ts`)
    /// before it reaches the job layer as `jobs::ProxyPolicy::export_masters`.
    #[serde(default)]
    pub export_masters: ExportMasters,
    /// When `false`, an import leaves the file where it is instead of copying
    /// it into the workspace's `Media/` (the item is marked
    /// `MediaItem::external`). **TS owns it** (`state/model.ts`); Rust mirrors
    /// it so the field survives a round trip. Default `true`.
    #[serde(default = "default_copy_media_on_import")]
    pub copy_media_on_import: bool,
}

/// Twin of TS `ShotReviewSettings`: the threshold and minimum shot length a
/// review settled on. `sensitivity` is an `f32` like `ShotOpts::sensitivity`,
/// so the value a project stores is the value the detector would be handed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShotReviewSettings {
    pub sensitivity: f32,
    pub min_shot_us: i64,
}

/// Twin of TS `PauseReviewSettings`: the three knobs the Pauses section tunes.
/// One recording session is one project, so the parameters belong to the
/// project rather than to the app. `threshold_amp` is an `f32` like
/// `DetectPausesArgs::threshold_amp` — amplitude, not the dB the UI shows — so
/// the value a project stores is the value the detector would be handed.
/// `pad_us` is per side, and the actor holds `2 × pad_us < min_pause_us`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PauseReviewSettings {
    pub threshold_amp: f32,
    pub min_pause_us: i64,
    pub pad_us: i64,
}

fn default_auto_pair_audio_on_import() -> bool {
    true
}

fn default_generate_preview_proxies() -> bool {
    true
}

fn default_copy_media_on_import() -> bool {
    true
}

/// Twin of TS `ExportMasters` (see `ProjectSettings::export_masters`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportMasters {
    #[default]
    Auto,
    OnImport,
    OnDemand,
}

/// Patch shape for `update_project_settings` — every field optional so the UI
/// can send tiny diffs without echoing the rest of the struct.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProjectSettingsPatch {
    pub prefer_proxies: Option<bool>,
    #[serde(default)]
    pub proxy_override: Option<ProxyOverridePatch>,
}

/// One entry of the `proxy_overrides` map, patched in or cleared.
/// `value: None` clears the override (falls back to the global preference).
#[derive(Clone, Debug, Deserialize)]
pub struct ProxyOverridePatch {
    pub media_id: String,
    pub value: Option<bool>,
}

/// Patch shape for `update_track_flags` — the timeline header's
/// eye/M/S/lock toggles. Preference-shaped like `ProjectSettingsPatch`:
/// applied to every history snapshot and never recorded, so Ctrl-Z never
/// flips a track toggle. Only `Some(_)` fields are applied.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct TrackFlagsPatch {
    pub enabled: Option<bool>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
    pub locked: Option<bool>,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            preview_width: 1280,
            preview_height: 720,
            autosave_interval_secs: Some(60),
            history_capacity: 200,
            auto_pair_audio_on_import: true,
            prefer_proxies: false,
            proxy_overrides: Default::default(),
            shot_review: None,
            pause_review: None,
            generate_preview_proxies: true,
            export_masters: ExportMasters::Auto,
            copy_media_on_import: true,
        }
    }
}

#[cfg(test)]
mod shot_review_tests {
    use super::*;

    /// A project written before the field existed carries no `shot_review`; it
    /// reads as the detector's defaults, the same `null` TS backfills.
    #[test]
    fn missing_shot_review_reads_as_none() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v["settings"].as_object_mut().unwrap().remove("shot_review");
        let back: Project = serde_json::from_value(v).unwrap();
        assert_eq!(back.settings.shot_review, None);
    }

    #[test]
    fn shot_review_round_trips_the_pair_ts_writes() {
        let mut p = Project::new_blank("t");
        let reviewed = ShotReviewSettings {
            sensitivity: 0.35,
            min_shot_us: 750_000,
        };
        p.settings.shot_review = Some(reviewed.clone());
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back.settings.shot_review, Some(reviewed));
    }
}

#[cfg(test)]
mod generate_preview_proxies_tests {
    use super::*;

    /// A project written before the toggle existed carries no
    /// `generate_preview_proxies`; it reads as `true` (proxies on), the same
    /// default TS backfills.
    #[test]
    fn missing_generate_preview_proxies_reads_as_true() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v["settings"]
            .as_object_mut()
            .unwrap()
            .remove("generate_preview_proxies");
        let back: Project = serde_json::from_value(v).unwrap();
        assert!(back.settings.generate_preview_proxies);
    }

    #[test]
    fn generate_preview_proxies_round_trips_false() {
        let mut p = Project::new_blank("t");
        p.settings.generate_preview_proxies = false;
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert!(!back.settings.generate_preview_proxies);
    }

    /// A project written before the setting existed reads as `Auto`.
    #[test]
    fn missing_export_masters_reads_as_auto() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v["settings"]
            .as_object_mut()
            .unwrap()
            .remove("export_masters");
        let back: Project = serde_json::from_value(v).unwrap();
        assert_eq!(back.settings.export_masters, ExportMasters::Auto);
    }

    #[test]
    fn export_masters_round_trips_as_snake_case() {
        let mut p = Project::new_blank("t");
        p.settings.export_masters = ExportMasters::OnDemand;
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["settings"]["export_masters"], "on_demand");
        let back: Project = serde_json::from_value(v).unwrap();
        assert_eq!(back.settings.export_masters, ExportMasters::OnDemand);
    }
}

#[cfg(test)]
mod pause_review_tests {
    use super::*;

    /// A project written before the field existed carries no `pause_review`; it
    /// reads as the detector's defaults, the same `null` TS backfills.
    #[test]
    fn missing_pause_review_reads_as_none() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v["settings"]
            .as_object_mut()
            .unwrap()
            .remove("pause_review");
        let back: Project = serde_json::from_value(v).unwrap();
        assert_eq!(back.settings.pause_review, None);
    }

    #[test]
    fn pause_review_round_trips_the_triple_ts_writes() {
        let mut p = Project::new_blank("t");
        let reviewed = PauseReviewSettings {
            threshold_amp: 0.02,
            min_pause_us: 500_000,
            pad_us: 100_000,
        };
        p.settings.pause_review = Some(reviewed.clone());
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back.settings.pause_review, Some(reviewed));
    }
}

#[cfg(test)]
mod role_tests {
    use super::*;

    #[test]
    fn legacy_project_without_audio_roles_defaults_to_unity() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v.as_object_mut().unwrap().remove("audio_roles");
        let back: Project = serde_json::from_value(v).unwrap();
        assert!(back.audio_roles.is_empty());
        let m = back.role_mix(AudioRole::Music);
        assert_eq!(m.gain_db, 0.0);
        assert!(!m.muted && !m.solo);
    }

    #[test]
    fn role_mix_reads_table_entry() {
        let mut p = Project::new_blank("t");
        p.audio_roles.insert(
            AudioRole::Dialogue,
            RoleMixSettings {
                gain_db: 6.0,
                muted: false,
                solo: true,
            },
        );
        let m = p.role_mix(AudioRole::Dialogue);
        assert_eq!(m.gain_db, 6.0);
        assert!(m.solo);
    }
}

#[cfg(test)]
mod copy_media_on_import_tests {
    use super::*;

    /// A project written before the toggle existed carries no
    /// `copy_media_on_import`; it reads as `true` (copy), upstream's behaviour
    /// and the default TS backfills.
    #[test]
    fn missing_copy_media_on_import_reads_as_true() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v["settings"]
            .as_object_mut()
            .unwrap()
            .remove("copy_media_on_import");
        let back: Project = serde_json::from_value(v).unwrap();
        assert!(back.settings.copy_media_on_import);
    }

    #[test]
    fn copy_media_on_import_round_trips_false() {
        let mut p = Project::new_blank("t");
        p.settings.copy_media_on_import = false;
        let json = serde_json::to_string(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert!(!back.settings.copy_media_on_import);
    }
}
