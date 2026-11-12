^XA
^CI28
^MMT

^PW480
^LL248
^LH0,0

^PR2
~SD28

^FX ============================
^FX PRODUCTO
^FX ============================
^FT40,40
^A0N,20,20
^FB440,2,0,C
^FD{PRODUCTO}^FS

^FX ============================
^FX PRECIO NORMAL
^FX ============================
^FT60,54
^A0N,20,20
^FB400,1,0,C
^FDPRECIO NORMAL: {PRECIO_NORMAL}^FS

^FX ============================
^FX PRECIO OFERTA (MAS GRANDE)
^FX ============================
^FT60,115
^A0N,70,52
^FB400,1,0,C
^FD{PRECIO}^FS

^FX ============================
^FX PRECIO UNITARIO
^FX ============================
^FT20,95
^A0N,14,14
^FD{PRECIO_UNIT} / {UM}^FS

^FT20,112
^A0N,12,12
^FDPrecio Unit.^FS

^FX ============================
^FX CODIGO DE BARRAS
^FX ============================
^BY2,2,30
^FT70,165
^BCN,40,N,N,N
^FD{EAN13}^FS

^FT120,188
^A0N,16,16
^FB240,1,0,C
^FD{EAN13}^FS

^FX ============================
^FX SKU
^FX ============================
^FT20,200
^A0N,16,16
^FDSKU:{SKU}^FS

^FX ============================
^FX FECHA
^FX ============================
^FT280,206
^A0N,16,16
^FB220,1,0,L
^FDVALIDO HASTA: {FECHA}^FS

^XZ