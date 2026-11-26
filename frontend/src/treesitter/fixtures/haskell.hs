{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE QuasiQuotes #-}

-- | Representative Haskell module for syntax highlighting parity with Helix.
-- TODO(alice): keep this sample covering every Haskell construct (#42)
-- FIXME: verify https://example.com/docs and @bob mentions
-- WARN: watch out for edge cases; HINT: check locals too
module Sample
  ( Colour (..),
    Point (px, py),
    Scale (..),
    Describable (..),
    evaluate,
    main,
  )
where

import Data.List (foldl')
import Data.Map.Strict qualified as Map
import Debug.Trace (traceShowId)
import Prelude hiding (lookup)

data Colour = Red | Green | Blue
  deriving (Eq, Show)

newtype Scale = Scale {unScale :: Double}
  deriving stock (Eq, Show)

data Point = Point
  { px :: !Double,
    py :: !Double
  }
  deriving (Eq, Show)

class Describable a where
  describe :: a -> String

instance Describable Colour where
  describe Red = "red"
  describe Green = "green"
  describe Blue = "blue"

origin :: Point
origin = Point {px = 0.0, py = -0.0}

unitVal :: ()
unitVal = ()

{- Block comment with NOTE: nested {- inner -} comment -}
evaluate :: Scale -> [Int] -> Int
evaluate (Scale factor) xs =
  let doubled = map (\n -> n * 2 + 1) xs
      shifted = (+ 1) <$> doubled
      total = foldl' (+) 0 shifted
   in case total of
        0 -> 0
        n
          | n < 0 -> error "negative"
          | n `mod` 2 == 0 -> traceShowId (round factor + n)
          | otherwise -> helper n
  where
    helper :: Int -> Int
    helper k
      | k > 100 = k - 42
      | otherwise = if True then k + fromEnum 'a' else fromEnum False

compose :: (b -> c) -> (a -> b) -> a -> c
compose f g = f . g

quoted :: String
quoted = [qq|hello from qq|]

rawSql :: String
rawSql = [sql|SELECT 1|]

main :: IO ()
main = do
  let m = Map.fromList [("a", 1 :: Int), ("λ", 2)]
  let flag = not False
  print $ evaluate (Scale 1.5) [1, 2, 3]
  print (describe Red, origin, unitVal, m, flag, quoted, rawSql)
