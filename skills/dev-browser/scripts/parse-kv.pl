#!/usr/bin/perl
# Parse key=value pairs with quoting support
# Supports: key=value  key='val with = signs'  key="quoted val"
# Unquoted values consume up to next key= boundary (spaces preserved)
# Output: key<TAB>value per line

my $s = $ARGV[0] // '';
my @pairs;
while ($s =~ /([a-zA-Z_][\w-]*)=((?:'[^']*'|"[^"]*"|(?:[^\s]|\s(?![a-zA-Z_][\w-]*=)))*)/) {
    my ($key, $val) = ($1, $2);
    # Capture the end offset BEFORE the substitutions below: s/// resets @+,
    # so reading $+[0] afterwards points at the strip-quotes match, not this one.
    my $end = $+[0];
    $val =~ s/^'(.*)'$/$1/ or $val =~ s/^"(.*)"$/$1/;
    push @pairs, "$key\t$val";
    $s = substr($s, $end);
}
print join("\n", @pairs) . "\n" if @pairs;
