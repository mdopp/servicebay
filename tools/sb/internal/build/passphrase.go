package build

import (
	"fmt"
	"io"
)

// passphraseWords is a curated list of short, common, unambiguous lowercase
// words (no look-alikes like l/1) for generating memorable passphrases. The
// host-console password is something an operator may have to type at a physical
// keyboard, so it favours typeability over maximum entropy. Four words from
// this ~160-word list plus a 2-digit number is ~2^35 — fine for a LAN console
// login, and far easier to type than a 48-char hex string.
var passphraseWords = []string{
	"able", "acid", "aged", "also", "area", "army", "atom", "aunt", "away", "baby",
	"back", "ball", "band", "bank", "barn", "base", "bath", "bead", "beam", "bean",
	"bear", "beat", "bell", "belt", "bird", "blue", "boat", "body", "bone", "book",
	"boot", "boss", "bowl", "bulk", "bush", "cake", "calm", "camp", "cane", "card",
	"cart", "cash", "cave", "cell", "chef", "chip", "city", "clay", "club", "coal",
	"coat", "code", "coin", "cold", "comb", "cook", "cool", "cord", "corn", "crew",
	"crop", "cube", "dawn", "deck", "deep", "deer", "desk", "dime", "dish", "dock",
	"dome", "door", "dove", "drum", "duck", "dune", "dusk", "earl", "east", "easy",
	"echo", "edge", "fair", "farm", "fawn", "fern", "film", "fire", "fish", "flag",
	"foam", "fork", "fort", "frog", "fuel", "gate", "gear", "gift", "glow", "goat",
	"gold", "good", "gulf", "hall", "hand", "hawk", "herb", "hill", "hive", "home",
	"hood", "hope", "horn", "iron", "jade", "kelp", "kind", "king", "lake", "lamp",
	"land", "lane", "leaf", "lion", "loft", "maze", "mild", "mint", "moon", "moss",
	"nest", "node", "oak", "oats", "palm", "park", "peak", "pine", "pond", "pony",
	"rain", "reef", "rice", "ring", "road", "rock", "rose", "ruby", "sage", "salt",
	"sand", "seal", "ship", "snow", "sock", "song", "star", "stem", "tide", "tiger",
	"vine", "wave", "wind", "wolf", "wood", "yard",
}

// Passphrase generates a memorable host-console password: four random words
// from passphraseWords plus a 2-digit number, hyphen-joined (e.g.
// "river-tiger-maple-stone-47"). It reads randomness from rnd (crypto/rand in
// production), is pipeline-safe (only lowercase letters, digits, hyphens), and
// is easy to type at a console.
func Passphrase(rnd io.Reader) (string, error) {
	const words = 4
	buf := make([]byte, words+1)
	if _, err := io.ReadFull(rnd, buf); err != nil {
		return "", err
	}
	out := ""
	for i := 0; i < words; i++ {
		out += passphraseWords[int(buf[i])%len(passphraseWords)]
		out += "-"
	}
	// Final segment: a 2-digit number 10–99 (never leading-zero, so it reads
	// cleanly and is unambiguously two digits).
	return fmt.Sprintf("%s%d", out, 10+int(buf[words])%90), nil
}
