import { expect, test } from 'bun:test';
import { splitName } from './names';

test('names split at scopes outside templates, parameters and msvc quotes', () => {
    expect(splitName('add')).toEqual(['add']);
    expect(splitName('geometry::Rect::area(int) const')).toEqual(['geometry', 'Rect', 'area']);
    expect(splitName('std::map<int, std::pair<a::B, c::D>>::insert(std::pair<int, int> const&)')).toEqual([
        'std',
        'map<int, std::pair<a::B, c::D>>',
        'insert',
    ]);
    expect(splitName("`anonymous namespace'::helper(int)")).toEqual(["`anonymous namespace'", 'helper']);
    expect(splitName('(anonymous namespace)::helper(int)')).toEqual(['(anonymous namespace)', 'helper']);
    expect(splitName("const geometry::Circle::`vftable'")).toEqual(['geometry', 'Circle', "`vftable'"]);
    expect(splitName('int add<int>(int, int)')).toEqual(['add<int>']);
});

test('names keep the symbols and words of operators', () => {
    expect(splitName('geometry::Rect::operator()(int)')).toEqual(['geometry', 'Rect', 'operator()']);
    expect(splitName('a::B::operator<<(int)')).toEqual(['a', 'B', 'operator<<']);
    expect(splitName('a::B::operator->() const')).toEqual(['a', 'B', 'operator->']);
    expect(splitName('a::B::operator int() const')).toEqual(['a', 'B', 'operator int']);
    expect(splitName('operator new[](unsigned long)')).toEqual(['operator new[]']);
    expect(splitName('a::B::operator std::string() const')).toEqual(['a', 'B', 'operator std::string']);
});

test('names keep the scopes of a name that only starts with the word operator', () => {
    expect(splitName('operators::add(int)')).toEqual(['operators', 'add']);
    expect(splitName('boost::operators_impl::less(int)')).toEqual(['boost', 'operators_impl', 'less']);
    expect(splitName('operator_table::find(int)')).toEqual(['operator_table', 'find']);
    expect(splitName('a::operator""_km(long double)')).toEqual(['a', 'operator""_km']);
});
