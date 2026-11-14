//! The small scripts items carry, in [Rhai](https://rhai.rs): a mental maths template's answer
//! and constraints, and a probability item's simulation.
//!
//! Scripts are sandboxed: they can't import modules, read files or print, and each run is
//! limited in how much work it can do. Their randomness comes from a seeded generator, so a
//! check gives the same result every time it's run.

use std::cell::RefCell;
use std::rc::Rc;

use rhai::{AST, Dynamic, Engine, Scope};

/// The most operations one run of a script may take, which stops a runaway loop.
const MAX_OPERATIONS: u64 = 200_000;

/// A small, fast generator whose sequence for a seed never changes, so an instance made from a
/// seed is the same on every machine and in every version of Workshop.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// SplitMix64.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in `low..=high`, which must not be empty.
    pub fn int_between(&mut self, low: i64, high: i64) -> i64 {
        assert!(low <= high, "an empty range: {low}..={high}");
        let span = (high as i128 - low as i128 + 1) as u128;
        // Rejection sampling, so every value is equally likely.
        let zone = u128::from(u64::MAX) + 1 - ((u128::from(u64::MAX) + 1) % span);
        loop {
            let value = u128::from(self.next_u64());
            if value < zone {
                return (low as i128 + (value % span) as i128) as i64;
            }
        }
    }
}

/// Runs an item's scripts, with randomness from the generator it shares with them.
pub struct Scripts {
    engine: Engine,
    rng: Rc<RefCell<Rng>>,
}

impl Scripts {
    pub fn new(seed: u64) -> Self {
        let rng = Rc::new(RefCell::new(Rng::new(seed)));
        let mut engine = Engine::new();
        engine.set_max_operations(MAX_OPERATIONS);
        engine.set_max_expr_depths(64, 32);
        engine.set_max_string_size(10_000);
        engine.set_max_array_size(100_000);
        engine.set_max_map_size(10_000);
        engine.set_max_call_levels(32);
        engine.on_print(|_| {});
        engine.on_debug(|_, _, _| {});
        engine.disable_symbol("eval");

        let r = rng.clone();
        engine.register_fn(
            "rand_int",
            move |low: i64, high: i64| -> Result<i64, Box<rhai::EvalAltResult>> {
                if low > high {
                    return Err(format!("rand_int({low}, {high}) has no values to pick").into());
                }
                Ok(r.borrow_mut().int_between(low, high))
            },
        );
        let r = rng.clone();
        engine.register_fn("rand_float", move || r.borrow_mut().next_f64());
        let r = rng.clone();
        engine.register_fn("rand_bool", move |p: f64| r.borrow_mut().next_f64() < p);
        let r = rng.clone();
        engine.register_fn(
            "rand_choice",
            move |items: rhai::Array| -> Result<Dynamic, Box<rhai::EvalAltResult>> {
                if items.is_empty() {
                    return Err("rand_choice([]) has nothing to pick".into());
                }
                let index = r.borrow_mut().int_between(0, items.len() as i64 - 1);
                Ok(items[index as usize].clone())
            },
        );
        let r = rng.clone();
        engine.register_fn("shuffle", move |items: rhai::Array| -> rhai::Array {
            let mut items = items;
            let mut rng = r.borrow_mut();
            for i in (1..items.len()).rev() {
                let j = rng.int_between(0, i as i64) as usize;
                items.swap(i, j);
            }
            items
        });
        Self { engine, rng }
    }

    /// Starts the shared generator again from `seed`.
    pub fn reseed(&self, seed: u64) {
        *self.rng.borrow_mut() = Rng::new(seed);
    }

    pub fn rng(&self) -> std::cell::RefMut<'_, Rng> {
        self.rng.borrow_mut()
    }

    pub fn compile(&self, source: &str) -> Result<AST, String> {
        self.engine
            .compile(source)
            .map_err(|err| format!("the script doesn't parse: {err}"))
    }

    pub fn compile_expression(&self, source: &str) -> Result<AST, String> {
        self.engine
            .compile_expression(source)
            .map_err(|err| format!("{source:?} isn't an expression: {err}"))
    }

    /// Runs a script, with these variables set.
    pub fn run(&self, ast: &AST, variables: &[(String, Value)]) -> Result<Value, String> {
        let mut scope = Scope::new();
        for (name, value) in variables {
            match value {
                Value::Int(n) => scope.push_constant(name.as_str(), *n),
                Value::Float(x) => scope.push_constant(name.as_str(), *x),
                Value::Bool(b) => scope.push_constant(name.as_str(), *b),
            };
        }
        let result: Dynamic = self
            .engine
            .eval_ast_with_scope(&mut scope, ast)
            .map_err(|err| format!("the script failed: {err}"))?;
        Value::from_dynamic(&result)
    }
}

/// What a script gives back: a number, or whether something happened.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Value {
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl Value {
    fn from_dynamic(value: &Dynamic) -> Result<Self, String> {
        if let Some(n) = value.clone().try_cast::<i64>() {
            Ok(Self::Int(n))
        } else if let Some(x) = value.clone().try_cast::<f64>() {
            if x.is_finite() {
                Ok(Self::Float(x))
            } else {
                Err(format!(
                    "the script gave {x}, which isn't a number it can use"
                ))
            }
        } else if let Some(b) = value.clone().try_cast::<bool>() {
            Ok(Self::Bool(b))
        } else {
            Err(format!(
                "the script gave a {}, where a number or true or false was needed",
                value.type_name()
            ))
        }
    }

    /// The value as a number, counting true as 1 and false as 0, as a simulation's trials do.
    pub fn as_f64(self) -> f64 {
        match self {
            Self::Int(n) => n as f64,
            Self::Float(x) => x,
            Self::Bool(b) => f64::from(u8::from(b)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generator_gives_the_same_numbers_for_a_seed() {
        let first: Vec<u64> = {
            let mut rng = Rng::new(42);
            (0..3).map(|_| rng.next_u64()).collect()
        };
        let mut again = Rng::new(42);
        assert_eq!(first, (0..3).map(|_| again.next_u64()).collect::<Vec<_>>());
        // Fixed forever, as instances are remade from their seeds.
        assert_eq!(Rng::new(0).next_u64(), 0xE220_A839_7B1D_CDAF);
    }

    #[test]
    fn picks_integers_evenly_within_the_range() {
        let mut rng = Rng::new(7);
        let mut counts = [0u32; 6];
        for _ in 0..60_000 {
            let roll = rng.int_between(1, 6);
            counts[(roll - 1) as usize] += 1;
        }
        for count in counts {
            assert!((9_000..11_000).contains(&count), "{counts:?}");
        }
        assert_eq!(rng.int_between(5, 5), 5);
        assert!((0..1000).all(|_| (-3..=3).contains(&rng.int_between(-3, 3))));
    }

    #[test]
    fn runs_scripts_with_variables_and_randomness() {
        let scripts = Scripts::new(1);
        let ast = scripts.compile_expression("a * b + 1").unwrap();
        let vars = [
            ("a".to_owned(), Value::Int(6)),
            ("b".to_owned(), Value::Int(7)),
        ];
        assert_eq!(scripts.run(&ast, &vars), Ok(Value::Int(43)));

        let roll = scripts
            .compile("let d = rand_int(1, 6); d >= 1 && d <= 6")
            .unwrap();
        assert_eq!(scripts.run(&roll, &[]), Ok(Value::Bool(true)));
        let float = scripts.compile_expression("a / 2.0").unwrap();
        assert_eq!(scripts.run(&float, &vars), Ok(Value::Float(3.0)));
    }

    #[test]
    fn stops_scripts_that_misbehave() {
        let scripts = Scripts::new(1);
        let forever = scripts.compile("loop { }").unwrap();
        assert!(scripts.run(&forever, &[]).unwrap_err().contains("failed"));
        assert!(scripts.compile("import \"x\" as x; 1").is_err());
        let text = scripts.compile("\"hello\"").unwrap();
        assert!(scripts.run(&text, &[]).unwrap_err().contains("string"));
        let nan = scripts.compile("0.0 / 0.0").unwrap();
        assert!(scripts.run(&nan, &[]).is_err());
        let empty = scripts.compile("rand_int(3, 1)").unwrap();
        assert!(scripts.run(&empty, &[]).is_err());
    }
}
