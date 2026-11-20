/**
 * The access flags of the class file format, where a method's `bridge` and `varargs` share bits with a field's
 * `volatile` and `transient`.
 */
export const access = {
    public: 0x1,
    private: 0x2,
    protected: 0x4,
    static: 0x8,
    final: 0x10,
    synchronized: 0x20,
    volatile: 0x40,
    bridge: 0x40,
    transient: 0x80,
    varargs: 0x80,
    native: 0x100,
    interface: 0x200,
    abstract: 0x400,
    synthetic: 0x1000,
    annotation: 0x2000,
    enum: 0x4000,
    module: 0x8000,
};
