use codex_core::config::find_codex_home;
use codex_core::protocol_config_types::ReasoningEffort;
use std::path::PathBuf;

#[cfg(feature = "cli")]
use serde::Deserialize;
#[cfg(feature = "cli")]
use serde_json::Value as JsonValue;

/// A simple preset pairing a model slug with a reasoning effort.
#[derive(Debug, Clone, Copy)]
pub struct ModelPreset {
    /// Stable identifier for the preset.
    pub id: &'static str,
    /// Display label shown in UIs.
    pub label: &'static str,
    /// Short human description shown next to the label in UIs.
    pub description: &'static str,
    /// Model slug (e.g., "gpt-5").
    pub model: &'static str,
    /// Reasoning effort to apply for this preset.
    pub effort: Option<ReasoningEffort>,
}

/// Built-in list of model presets that pair a model with a reasoning effort.
///
/// Keep this UI-agnostic so it can be reused by both TUI and MCP server.
pub fn builtin_model_presets() -> &'static [ModelPreset] {
    // Order groups swiftfox variants before gpt-5 presets, each from minimal to high.
    const PRESETS: &[ModelPreset] = &[
        ModelPreset {
            id: "swiftfox-low",
            label: "swiftfox low",
            description: "",
            model: "swiftfox-low",
            effort: None,
        },
        ModelPreset {
            id: "swiftfox-medium",
            label: "swiftfox medium",
            description: "",
            model: "swiftfox-medium",
            effort: None,
        },
        ModelPreset {
            id: "swiftfox-high",
            label: "swiftfox high",
            description: "",
            model: "swiftfox-high",
            effort: None,
        },
        ModelPreset {
            id: "gpt-5-minimal",
            label: "gpt-5 minimal",
            description: "— fastest responses with limited reasoning; ideal for coding, instructions, or lightweight tasks",
            model: "gpt-5",
            effort: Some(ReasoningEffort::Minimal),
        },
        ModelPreset {
            id: "gpt-5-low",
            label: "gpt-5 low",
            description: "— balances speed with some reasoning; useful for straightforward queries and short explanations",
            model: "gpt-5",
            effort: Some(ReasoningEffort::Low),
        },
        ModelPreset {
            id: "gpt-5-medium",
            label: "gpt-5 medium",
            description: "— default setting; provides a solid balance of reasoning depth and latency for general-purpose tasks",
            model: "gpt-5",
            effort: Some(ReasoningEffort::Medium),
        },
        ModelPreset {
            id: "gpt-5-high",
            label: "gpt-5 high",
            description: "— maximizes reasoning depth for complex or ambiguous problems",
            model: "gpt-5",
            effort: Some(ReasoningEffort::High),
        },
    ];
    PRESETS
}

/// Owned version of a model preset to support dynamically loaded presets.
#[derive(Debug, Clone)]
pub struct OwnedModelPreset {
    pub id: String,
    pub label: String,
    pub description: String,
    pub model: String,
    pub effort: Option<ReasoningEffort>,
}

impl From<&ModelPreset> for OwnedModelPreset {
    fn from(p: &ModelPreset) -> Self {
        Self {
            id: p.id.to_string(),
            label: p.label.to_string(),
            description: p.description.to_string(),
            model: p.model.to_string(),
            effort: p.effort,
        }
    }
}

#[cfg(feature = "cli")]
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum UserPresetEntry {
    /// Simple form: just a model slug, everything else inferred.
    ModelOnly(String),
    /// Full form: explicit fields.
    Full {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        description: Option<String>,
        model: String,
        #[serde(default)]
        effort: Option<ReasoningEffort>,
    },
}

#[cfg(feature = "cli")]
fn parse_user_presets(json: &str) -> Option<Vec<OwnedModelPreset>> {
    let value: JsonValue = serde_json::from_str(json).ok()?;
    let arr = match value {
        JsonValue::Array(a) => a,
        _ => return None,
    };

    let mut out = Vec::new();
    for v in arr.into_iter() {
        // Try both forms via serde.
        if let Ok(UserPresetEntry::ModelOnly(model)) =
            serde_json::from_value::<UserPresetEntry>(v.clone())
        {
            let label = model.clone();
            let id = model.clone();
            out.push(OwnedModelPreset {
                id,
                label,
                description: String::new(),
                model,
                effort: None,
            });
            continue;
        }
        if let Ok(UserPresetEntry::Full {
            id,
            label,
            description,
            model,
            effort,
        }) = serde_json::from_value::<UserPresetEntry>(v)
        {
            let label = label.unwrap_or_else(|| model.clone());
            let id = id.unwrap_or_else(|| model.clone());
            let description = description.unwrap_or_default();
            out.push(OwnedModelPreset {
                id,
                label,
                description,
                model,
                effort,
            });
            continue;
        }
        // Skip invalid entries.
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Determine the JSON file path for user-defined model presets.
///
/// Resolution order:
/// - $CODEX_MODELS_FILE when set and non-empty
/// - $CODEX_HOME/models.json (defaults to ~/.codex/models.json)
#[cfg(feature = "cli")]
fn user_presets_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CODEX_MODELS_FILE") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    if let Ok(home) = find_codex_home() {
        return Some(home.join("models.json"));
    }
    None
}

/// Load model presets from user JSON if available; otherwise return the built-ins.
///
/// The user JSON can be either an array of strings, e.g.:
///   ["Qwen3-coder", "Qwen3-235B", "Qwen3-Max.Preview"]
/// or an array of objects with optional metadata, e.g.:
///   [{"model":"Qwen3-coder","label":"Qwen3 coder","effort":"low"}, ...]
#[cfg(feature = "cli")]
pub fn load_model_presets_owned() -> Vec<OwnedModelPreset> {
    if let Some(path) = user_presets_path() {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let Some(list) = parse_user_presets(&contents) {
                return list;
            }
        }
    }
    // Fallback to built-in presets.
    builtin_model_presets()
        .iter()
        .map(OwnedModelPreset::from)
        .collect()
}

#[cfg(not(feature = "cli"))]
pub fn load_model_presets_owned() -> Vec<OwnedModelPreset> {
    // Without CLI feature (Serde), just return the built-ins as owned presets.
    builtin_model_presets()
        .iter()
        .map(OwnedModelPreset::from)
        .collect()
}
