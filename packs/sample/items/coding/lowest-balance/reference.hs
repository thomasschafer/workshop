module Main where

lowestBalance :: [Int] -> Int
lowestBalance changes = minimum (scanl (+) 0 changes)

main :: IO ()
main = do
  n : changes <- map read . words <$> getContents
  print (lowestBalance (take n changes))
