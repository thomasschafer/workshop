package sample

// Representative Go file for syntax highlighting parity with Helix.
// TODO(alice): cover common Go constructs and injections (#42)
// FIXME: check https://example.com/docs and @bob mentions

import (
	"errors"
	"fmt"
	"regexp"
)

var tokenPattern = regexp.MustCompile(`^([a-z_]+)=(\d+)$`)

const defaultScale = 2

type Describable interface {
	Describe() string
}

type Point[T ~int | ~float64] struct {
	X T
	Y T
}

func (p Point[T]) Describe() string {
	return fmt.Sprintf("(%v, %v)", p.X, p.Y)
}

func Evaluate(values []int, factor int) (int, error) {
	if factor <= 0 {
		return 0, errors.New("factor must be positive")
	}
	total := 0
	for i, v := range values {
		switch {
		case v < 0:
			return 0, fmt.Errorf("negative value %d at index %02d", v, i)
		case v%2 == 0:
			total += v * factor
		default:
			total += v + defaultScale
		}
	}
	return total, nil
}

func Demo() {
	ch := make(chan string, 1)
	defer close(ch)
	go func(label string) {
		m := tokenPattern.FindStringSubmatch("count=42")
		ch <- fmt.Sprintf("%s: %q (len=%d)", label, m[0], len(m))
	}("hit")
	msg := <-ch
	p := Point[int]{X: 3, Y: 4}
	fmt.Printf("point=%s msg=%s ok=%t\n", p.Describe(), msg, true)
}
