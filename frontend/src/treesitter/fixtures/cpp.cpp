// Representative C++ file for syntax highlighting parity with Helix.
// TODO(alice): cover common C++ constructs and injections (#42)
// FIXME: check https://example.com/docs and @bob mentions

#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#define SCALE_VALUE(x) ((x) * 2 + 1)

namespace sample {

enum class Colour { Red, Green, Blue };

template <typename T>
struct Point {
  T x{};
  T y{};

  constexpr T manhattan() const noexcept { return x + y; }
};

class Evaluator {
 public:
  explicit Evaluator(int factor) : factor_(factor) {}
  virtual ~Evaluator() = default;

  virtual int evaluate(const std::vector<int>& values) const {
    int total = 0;
    auto adjust = [this](int n) { return n * factor_; };
    for (int v : values) {
      if (v < 0) {
        throw std::invalid_argument("negative value");
      }
      total += (v % 2 == 0) ? adjust(v) : SCALE_VALUE(v);
    }
    return total;
  }

 private:
  int factor_;
};

inline const char* pattern() {
  return R"regex(^([a-z_]+)=(\d+)$)regex";
}

}  // namespace sample

int main() {
  auto eval = std::make_unique<sample::Evaluator>(3);
  sample::Point<int> pt{1, 2};
  std::vector<int> nums{1, 2, 3};
  std::cout << eval->evaluate(nums) << ' ' << pt.manhattan() << ' ' << sample::pattern() << '\n';
  return 0;
}
