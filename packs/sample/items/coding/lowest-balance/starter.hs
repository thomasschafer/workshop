module Main where

lowestBalance :: [Int] -> Int
lowestBalance changes = undefined

main :: IO ()
main = do
  n : changes <- map read . words <$> getContents
  print (lowestBalance (take n changes))
