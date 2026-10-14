using System.Text;

public static class WireInput
{
    public static async Task<string?> ReadLine(TextReader reader,int maximum,CancellationToken token)
    {
        var builder=new StringBuilder();var character=new char[1];
        while(await reader.ReadAsync(character.AsMemory(),token)!=0)
        {
            if(character[0]=='\n') return builder.ToString().TrimEnd('\r');
            if(builder.Length>=maximum) throw new InvalidDataException("CONTROL_LINE_LIMIT");
            builder.Append(character[0]);
        }
        if(builder.Length!=0) throw new InvalidDataException("CONTROL_LINE_TRUNCATED");
        return null;
    }
}
