//! Learning from packs: a log of every attempt, when each item comes back, what to do next
//! within the day's and the week's limits, and how well each skill is known.
//!
//! The log of attempts is what's true; schedules and mastery are worked out from it, so
//! attempts made offline on another device fit in wherever they belong once they arrive.

pub mod level;
pub mod mastery;
pub mod mistakes;
pub mod plan;
pub mod schedule;
pub mod store;

pub use level::{SkillLevel, levels};
pub use mastery::{SkillMastery, history, mastery};
pub use mistakes::{Mistake, MistakeSource, NewMistake};
pub use plan::{Clock, ItemRef, LessonPlanRef, Limits, Progress, TrackPlan, due, plan};
pub use schedule::{ItemSchedule, Rating, Scheduler};
pub use store::{
    Activity, Attempt, Flag, FlagChange, LessonCompletion, LessonSkip, Retirement,
    RetirementChange, Store, standings,
};
