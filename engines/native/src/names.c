#include "session.h"

// cuts longer names, so a hostile binary can't make every reply huge
#define MAX_NAME_BYTES 1024

static const char *const calling_conventions[] = { "__cdecl ", "__stdcall ", "__fastcall ", "__thiscall ", "__vectorcall ",
	"__clrcall " };

// words of the MSVC demangler that other compilers' names don't have: the size of a pointer and the keywords
// before a type
static const char *const msvc_words[] = { " __ptr64", "class ", "struct ", "union ", "enum " };

/**
 * \brief Returns the length of the word of msvc_words at a place of a name, or 0 where none starts.
 *
 * Takes a keyword only at the start of a type, which follows `(`, `<`, `,` or a space of the text written so far.
 */
static size_t msvc_word_at(const char *at, const char *written, size_t written_length) {
	for (size_t i = 0; i < RZ_ARRAY_SIZE(msvc_words); i++) {
		const char *word = msvc_words[i];
		bool starts_type = word[0] == ' ' || !written_length || strchr("(<, ", written[written_length - 1]);
		if (starts_type && rz_str_startswith(at, word)) {
			return strlen(word);
		}
	}
	return 0;
}

/**
 * \brief Removes the words of msvc_words from a name in place and cuts it to MAX_NAME_BYTES, like `f(class
 * std::string const & __ptr64)` to `f(std::string const &)`.
 *
 * Reads the name once, so a long name costs no more than its length.
 */
static void drop_msvc_words(char *text) {
	size_t length = 0;
	for (const char *at = text; *at && length < MAX_NAME_BYTES;) {
		size_t skipped = msvc_word_at(at, text, length);
		if (skipped) {
			at += skipped;
		} else {
			text[length++] = *at++;
		}
	}
	text[length] = '\0';
}

/**
 * \brief Returns a name without the access, return type and calling convention that MSVC names have and without the
 * other words of msvc_words, cut to MAX_NAME_BYTES.
 *
 * Turns `public: long int __cdecl geometry::Rect::area(int)const __ptr64` into `geometry::Rect::area(int)const`. The
 * caller frees the result with free().
 */
char *names_clean(const char *name) {
	const char *start = name;
	for (size_t i = 0; i < RZ_ARRAY_SIZE(calling_conventions); i++) {
		const char *convention = strstr(name, calling_conventions[i]);
		if (convention) {
			start = convention + strlen(calling_conventions[i]);
			break;
		}
	}

	char *text = rz_str_dup(start);
	drop_msvc_words(text);
	return text;
}

/**
 * \brief Returns the clean demangled name of a symbol, or NULL for a symbol without a name.
 *
 * Drops the underscore that Mach-O files put in front of C function names. The caller frees the result with
 * free().
 */
char *names_of_symbol(RzBinObject *object, const RzBinSymbol *symbol) {
	if (RZ_STR_ISNOTEMPTY(symbol->dname)) {
		return names_clean(symbol->dname);
	}
	if (RZ_STR_ISEMPTY(symbol->name)) {
		return NULL;
	}

	bool is_underscored = object->plugin && rz_str_startswith(object->plugin->name, "mach0");
	return names_clean(symbol->name + (is_underscored && symbol->name[0] == '_' && symbol->name[1]));
}
