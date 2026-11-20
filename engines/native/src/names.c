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
 * \brief Returns a name without the access and calling convention that MSVC names have and without the other words of
 * msvc_words, cut to MAX_NAME_BYTES, with the return type in front when `keep_return` is set.
 *
 * The caller frees the result with free().
 */
static char *without_msvc_parts(const char *name, bool keep_return) {
	const char *start = name;
	const char *convention = NULL;
	for (size_t i = 0; i < RZ_ARRAY_SIZE(calling_conventions) && !convention; i++) {
		convention = strstr(name, calling_conventions[i]);
		start = convention ? convention + strlen(calling_conventions[i]) : start;
	}

	RzStrBuf *result = rz_strbuf_new(NULL);
	if (convention && keep_return) {
		const char *access = strstr(name, ": ");
		const char *type = access && access < convention ? access + 2 : name;
		rz_strbuf_append_n(result, type, convention - type);
	}
	rz_strbuf_append(result, start);

	char *text = rz_strbuf_drain(result);
	drop_msvc_words(text);
	return text;
}

/**
 * \brief Returns a name without the access, return type and calling convention that MSVC names have and without the
 * other words of msvc_words.
 *
 * Turns `public: long int __cdecl geometry::Rect::area(int)const __ptr64` into `geometry::Rect::area(int)const`. The
 * caller frees the result with free().
 */
char *names_clean(const char *name) {
	return without_msvc_parts(name, false);
}

/**
 * \brief Returns a demangled name as a signature, which keeps the return type of an MSVC name, like `long int
 * geometry::Rect::area(int)const` for `public: long int __cdecl geometry::Rect::area(int)const __ptr64`.
 *
 * The caller frees the result with free().
 */
char *names_signature(const char *name) {
	return without_msvc_parts(name, true);
}

/**
 * \brief Returns the demangled name of a symbol as the demangler writes it, or NULL for a symbol without a name.
 *
 * Drops the underscore that Mach-O files put in front of C function names.
 */
const char *names_raw_of_symbol(RzBinObject *object, const RzBinSymbol *symbol) {
	if (RZ_STR_ISNOTEMPTY(symbol->dname)) {
		return symbol->dname;
	}
	if (RZ_STR_ISEMPTY(symbol->name)) {
		return NULL;
	}

	bool is_underscored = object->plugin && rz_str_startswith(object->plugin->name, "mach0");
	return symbol->name + (is_underscored && symbol->name[0] == '_' && symbol->name[1]);
}

/**
 * \brief Returns the clean demangled name of a symbol, or NULL for a symbol without a name.
 *
 * The caller frees the result with free().
 */
char *names_of_symbol(RzBinObject *object, const RzBinSymbol *symbol) {
	const char *raw = names_raw_of_symbol(object, symbol);
	return raw ? names_clean(raw) : NULL;
}

/**
 * \brief Adds the access and the words `static` and `virtual` that an MSVC name starts with to a symbol's JSON.
 *
 * The MSVC demangler writes them like `public: static int` or `public virtual: long`, so a name that only starts like
 * an access, like `privately::helper(int)`, has none.
 */
void names_add_msvc_words(PJ *j, const char *name) {
	static const char *const accesses[] = { "public", "protected", "private" };
	const char *access = NULL;
	const char *colon = NULL;
	for (size_t i = 0; i < RZ_ARRAY_SIZE(accesses) && !colon; i++) {
		const char *after = rz_str_startswith(name, accesses[i]) ? name + strlen(accesses[i]) : "";
		after += rz_str_startswith(after, " virtual") ? strlen(" virtual") : 0;
		if (rz_str_startswith(after, ": ")) {
			access = accesses[i];
			colon = after;
		}
	}
	if (!colon) {
		return;
	}

	char *words = rz_str_ndup(name, colon - name);
	const char *after = colon + 1;
	pj_ks(j, "access", access);
	pj_kb(j, "static", strstr(words, " static") || rz_str_startswith(after, " static "));
	pj_kb(j, "virtual", strstr(words, " virtual") || rz_str_startswith(after, " virtual "));
	free(words);
}

/**
 * \brief Cuts the parameter list from a demangled name, so `geometry::Rect::area(int) const` becomes
 * `geometry::Rect::area`.
 *
 * The list is the last group of parentheses, which keeps the parentheses in a name like `operator()`.
 */
static void cut_parameters(char *name) {
	char *close = strrchr(name, ')');
	int depth = 0;
	for (char *at = close; at && at >= name; at--) {
		if (*at == ')') {
			depth++;
		} else if (*at == '(') {
			depth--;
		}
		if (!depth) {
			*at = '\0';
			return;
		}
	}
}

/**
 * \brief Returns the clean name of the symbol, the PDB function or the entry point at an address, or NULL.
 *
 * The caller frees the result with free().
 */
static char *name_at(RzCore *core, ut64 addr) {
	RzBinObject *object = rz_bin_cur_object(core->bin);
	if (!object) {
		return NULL;
	}

	RzBinSymbol *symbol = rz_bin_object_get_symbol_at(object, addr, true);
	char *name = symbol ? names_of_symbol(object, symbol) : NULL;
	if (name) {
		return name;
	}

	const RzList *flags = rz_flag_get_list(core->flags, addr);
	RzListIter *flag_it;
	RzFlagItem *flag;
	rz_list_foreach (flags, flag_it, flag) {
		if (rz_str_startswith(flag->name, "pdb.") && RZ_STR_ISNOTEMPTY(flag->realname)) {
			return names_clean(flag->realname);
		}
	}

	const RzPVector *entries = rz_bin_object_get_entries(object);
	void **it;
	if (entries) {
		rz_pvector_foreach (entries, it) {
			if (((RzBinAddr *)*it)->vaddr == addr) {
				return rz_str_dup("entry");
			}
		}
	}
	return NULL;
}

/**
 * \brief Returns the name of the function at an address for code, without its parameters, or `sub_<address>` for a
 * function without a name.
 *
 * The caller frees the result with free().
 */
char *names_for_code(RzCore *core, ut64 addr) {
	char *name = name_at(core, addr);
	if (name) {
		cut_parameters(name);
	}
	if (RZ_STR_ISEMPTY(name)) {
		free(name);
		return rz_str_newf("sub_%" PFMT64x, addr);
	}
	return name;
}
